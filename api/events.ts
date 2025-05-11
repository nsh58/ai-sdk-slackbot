import type { SlackEvent } from "@slack/web-api";
import {
  assistantThreadMessage,
  handleNewAssistantMessage,
} from "../lib/handle-messages";
import { waitUntil } from "@vercel/functions";
import { handleNewAppMention } from "../lib/handle-app-mention";
import { verifyRequest, getBotId, checkIfAlreadyResponded } from "../lib/slack-utils";

// メモリ内キャッシュで処理済みのイベントIDを管理
const processedEventIds = new Set<string>();
const MAX_CACHE_SIZE = 100;
const processedEventQueue: string[] = [];

// イベントの重複処理を防止する関数
function isEventProcessed(eventId: string): boolean {
  if (processedEventIds.has(eventId)) {
    console.log(`重複イベント検出: ${eventId} (Vercel)`);
    return true;
  }
  
  // イベントIDをキャッシュに追加
  processedEventIds.add(eventId);
  processedEventQueue.push(eventId);
  
  // キャッシュサイズを制限
  if (processedEventQueue.length > MAX_CACHE_SIZE) {
    const oldestEventId = processedEventQueue.shift();
    if (oldestEventId) processedEventIds.delete(oldestEventId);
  }
  
  return false;
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const payload = JSON.parse(rawBody);
  const requestType = payload.type as "url_verification" | "event_callback";

  // See https://api.slack.com/events/url_verification
  if (requestType === "url_verification") {
    return new Response(payload.challenge, { status: 200 });
  }

  // イベントの重複処理を防止（event_idを使用）
  if (requestType === "event_callback" && payload.event && payload.event_id) {
    if (isEventProcessed(payload.event_id)) {
      console.log(`イベントID ${payload.event_id} は既に処理済みです。スキップします。`);
      return new Response("Event already processed", { status: 200 });
    }
  }

  // Request型のヘッダーをRecord<string, string>に変換
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  
  await verifyRequest({ requestType, request: { headers }, rawBody });

  try {
    const botUserId = await getBotId();
    const event = payload.event as SlackEvent;

    // app_mention イベントの処理
    if (event.type === "app_mention") {
      // スレッド履歴をチェックして既に応答済みか確認
      if ('channel' in event && 'ts' in event) {
        try {
          const isAlreadyProcessed = await checkIfAlreadyResponded(event);
          if (isAlreadyProcessed) {
            console.log(`このイベント(${event.ts})には既に応答済みです。処理をスキップします。`);
            return new Response("Event already responded", { status: 200 });
          }
        } catch (error) {
          console.error("応答チェック中にエラー:", error);
          // エラーが発生しても処理は続行する（最悪の場合重複応答になる）
        }
      }

      // 非同期でメンション処理を開始
      waitUntil(handleNewAppMention(event, botUserId));
    }

    // その他のイベント処理（assistant_thread_startedやmessage）
    if (event.type === "assistant_thread_started") {
      waitUntil(assistantThreadMessage(event));
    }

    if (
      event.type === "message" &&
      !('subtype' in event && event.subtype) &&
      'channel_type' in event && event.channel_type === "im" &&
      !('bot_id' in event && event.bot_id) &&
      !('bot_profile' in event && event.bot_profile) &&
      !('bot_id' in event && event.bot_id === botUserId)
    ) {
      // メッセージイベントでも既に応答済みかチェック
      if ('channel' in event && 'ts' in event) {
        try {
          const isAlreadyProcessed = await checkIfAlreadyResponded(event);
          if (isAlreadyProcessed) {
            console.log(`このメッセージ(${event.ts})には既に応答済みです。処理をスキップします。`);
            return new Response("Message already responded", { status: 200 });
          }
        } catch (error) {
          console.error("応答チェック中にエラー:", error);
        }
      }
      
      waitUntil(handleNewAssistantMessage(event, botUserId));
    }

    return new Response("Success!", { status: 200 });
  } catch (error) {
    console.error("Error generating response", error);
    return new Response("Error generating response", { status: 500 });
  }
}
