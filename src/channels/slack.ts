import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// Per-app state — each Slack App instance has its own bot user ID.
interface AppEntry {
  app: App;
  botUserId: string | undefined;
}

export class SlackChannel implements Channel {
  name = 'slack';

  // Default app (Nani's own bot token from .env). Used for groups that have
  // no per-agent tokens configured and as the catch-all event listener.
  private defaultApp: App;
  private defaultBotUserId: string | undefined;

  // Per-channel-JID app instances for agent bots (Nemo, Campy, Rabio, …).
  // Keyed by the Slack channel JID ("slack:<channelId>").
  // Populated during connect() from registeredGroups that carry slackBotToken.
  private agentApps: Map<string, AppEntry> = new Map();

  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.defaultApp = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlersForApp(this.defaultApp, () => this.defaultBotUserId);
  }

  // Wire up Bolt event handlers for a given App instance.
  // getBotUserId is a thunk so it can be read lazily after connect().
  private setupEventHandlersForApp(
    app: App,
    getBotUserId: () => string | undefined,
  ): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message') return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      if (!msg.text) return;

      // Threaded replies are flattened into the channel conversation.
      // The agent sees them alongside channel-level messages; responses
      // always go to the channel, not back into the thread.

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      const botUserId = getBotUserId();
      const isBotMessage = !!msg.bot_id || msg.user === botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user, app) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      // Use the group's own trigger name (e.g. "@Nemo") not the global ASSISTANT_NAME,
      // so per-agent bots identify correctly when mentioned.
      let content = msg.text;
      if (botUserId && !isBotMessage) {
        const mentionPattern = `<@${botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          const group = groups[jid];
          const agentName = group?.trigger?.replace(/^@/, '') || ASSISTANT_NAME;
          content = `@${agentName} ${content}`;
        }
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
      });
    });
  }

  async connect(): Promise<void> {
    // Start the default (Nani) app first
    await this.defaultApp.start();

    // Resolve default bot user ID
    try {
      const auth = await this.defaultApp.client.auth.test();
      this.defaultBotUserId = auth.user_id as string;
      logger.info(
        { botUserId: this.defaultBotUserId },
        'Connected to Slack (default bot)',
      );
    } catch (err) {
      logger.warn(
        { err },
        'Connected to Slack but failed to get default bot user ID',
      );
    }

    // Start per-agent App instances for any registered groups that have their own tokens
    await this.startAgentApps();

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  // For each registered group that carries slackBotToken + slackAppToken,
  // spin up a dedicated App instance and store it in agentApps.
  private async startAgentApps(): Promise<void> {
    const groups = this.opts.registeredGroups();
    for (const [jid, group] of Object.entries(groups)) {
      if (!group.slackBotToken || !group.slackAppToken) continue;
      if (this.agentApps.has(jid)) continue; // already running

      try {
        const agentApp = new App({
          token: group.slackBotToken,
          appToken: group.slackAppToken,
          socketMode: true,
          logLevel: LogLevel.ERROR,
        });

        const entry: AppEntry = { app: agentApp, botUserId: undefined };
        this.agentApps.set(jid, entry);

        // Wire events — use a stable reference so the closure always reads the
        // latest botUserId even after the auth.test() call below.
        this.setupEventHandlersForApp(agentApp, () => entry.botUserId);

        await agentApp.start();

        try {
          const auth = await agentApp.client.auth.test();
          entry.botUserId = auth.user_id as string;
          logger.info(
            { jid, botUserId: entry.botUserId, folder: group.folder },
            'Agent Slack bot connected',
          );
        } catch (err) {
          logger.warn(
            { jid, err },
            'Agent Slack bot connected but failed to get bot user ID',
          );
        }
      } catch (err) {
        logger.error({ jid, err }, 'Failed to start agent Slack bot');
      }
    }
  }

  // Return the App to use for sending to a given JID.
  // Agent groups with their own app use it; everything else falls back to default.
  private appFor(jid: string): App {
    return this.agentApps.get(jid)?.app ?? this.defaultApp;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    const app = this.appFor(jid);

    try {
      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await app.client.chat.postMessage({ channel: channelId, text });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    // Stop all agent apps first, then the default app
    for (const [jid, entry] of this.agentApps.entries()) {
      try {
        await entry.app.stop();
      } catch (err) {
        logger.warn({ jid, err }, 'Error stopping agent Slack bot');
      }
    }
    this.agentApps.clear();
    await this.defaultApp.stop();
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  async addReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    const app = this.appFor(jid);
    try {
      await app.client.reactions.add({
        channel: channelId,
        name: emoji,
        timestamp: messageId,
      });
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to add Slack reaction');
    }
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   * Runs against the default app (Nani) — agent bots will be in their own channels.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.defaultApp.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(
    userId: string,
    app: App,
  ): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        const app = this.appFor(item.jid);
        await app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
