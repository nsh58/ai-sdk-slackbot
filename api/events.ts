import type { SlackEvent } from "@slack/web-api";
import {
  assistantThreadMessage,
  handleNewAssistantMessage,
} from "../lib/handle-messages";
import { handleNewAppMention } from "../lib/handle-app-mention";
import { verifyRequest, getBotId, checkIfAlreadyResponded } from "../lib/slack-utils";

// メモリ内キャッシュで処理済みのイベントIDを管理
const processedEventIds = new Set<string>();
const MAX_CACHE_SIZE = 100;
const processedEventQueue: string[] = [];

// イベントの重複処理を防止する関数
function isEventProcessed(eventId: string): boolean {
  if (processedEventIds.has(eventId)) {
    console.log(`重複イベント検出: ${eventId}`);
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

// 注意: このファイルはLambda環境では使用されません。
// Lambda用の処理はlambda.tsファイルを参照してください.
