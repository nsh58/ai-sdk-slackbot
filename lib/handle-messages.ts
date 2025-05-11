import type {
  AssistantThreadStartedEvent,
  GenericMessageEvent,
  MessageEvent, // MessageEvent型をインポート
} from "@slack/web-api";
import { client, getThread, updateStatusUtil } from "./slack-utils";
import { generateResponse } from "./generate-response";

export async function assistantThreadMessage(
  event: AssistantThreadStartedEvent,
) {
  const { channel_id, thread_ts } = event.assistant_thread;
  console.log(`Thread started: ${channel_id} ${thread_ts}`);
  console.log(JSON.stringify(event));

  await client.chat.postMessage({
    channel: channel_id,
    thread_ts: thread_ts,
    text: "Hello, I'm an AI assistant built with the AI SDK by Vercel!",
  });

  await client.assistant.threads.setSuggestedPrompts({
    channel_id: channel_id,
    thread_ts: thread_ts,
    prompts: [
      {
        title: "Get the weather",
        message: "What is the current weather in London?",
      },
      {
        title: "Get the news",
        message: "What is the latest Premier League news from the BBC?",
      },
    ],
  });
}

export async function handleNewAssistantMessage(
  event: MessageEvent, // GenericMessageEventからより広い範囲のMessageEventに変更
  botUserId: string,
) {
  // botメッセージや特定の条件のメッセージは処理しない
  if (
    ("bot_id" in event && event.bot_id) ||
    ("bot_id" in event && event.bot_id === botUserId) ||
    ("bot_profile" in event && event.bot_profile) ||
    !("thread_ts" in event && event.thread_ts)
  )
    return;

  const thread_ts = event.thread_ts;
  const channel = event.channel;
  const updateStatus = updateStatusUtil(channel, thread_ts);
  await updateStatus("is thinking...");

  const messages = await getThread(channel, thread_ts, botUserId);
  const result = await generateResponse(messages, updateStatus);

  await client.chat.postMessage({
    channel: channel,
    thread_ts: thread_ts,
    text: result,
    unfurl_links: false,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: result,
        },
      },
    ],
  });

  await updateStatus("");
}
