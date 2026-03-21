/**
 * Core types for MotherClaw orchestrator.
 */

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean;
  isMain?: boolean;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number;
}

export interface AdditionalMount {
  hostPath: string;
  containerPath?: string;
  readonly?: boolean;
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

/** Callback type for inbound messages from channels */
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

/** Callback for chat metadata discovery */
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;

/** Channel abstraction */
export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;
