import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { SlackEvent } from "@slack/web-api";
import {
  assistantThreadMessage,
  handleNewAssistantMessage,
} from "./lib/handle-messages";
import { handleNewAppMention } from "./lib/handle-app-mention";
import { verifyRequest, getBotId } from "./lib/slack-utils";

// タイムアウト監視用の非同期タイマー関数
const createTimeout = (ms: number): Promise<never> => {
  return new Promise((_, reject) => 
    setTimeout(() => reject(new Error(`処理がタイムアウトしました (${ms}ms)`)), ms)
  );
};

// Slackのリトライリクエストかどうかを判定する関数
const isRetryRequest = (headers: Record<string, string | undefined>): boolean => {
  // ヘッダー名は小文字で統一されていることが多いので、大文字小文字を区別せずチェック
  const headers_lower: Record<string, string | undefined> = {};
  Object.keys(headers).forEach(key => {
    headers_lower[key.toLowerCase()] = headers[key];
  });

  // リトライ番号をチェック
  const retryNum = headers_lower['x-slack-retry-num'];
  const retryReason = headers_lower['x-slack-retry-reason'];
  
  if (retryNum) {
    console.log(`Slackリトライを検出: 回数=${retryNum}, 理由=${retryReason || '不明'}`);
    return true;
  }
  return false;
};

// 処理済みのイベントIDを保存するセット（メモリ内キャッシュ）
// Lambda関数の再起動ごとにリセットされるため、完全な重複排除はできないが
// 同一インスタンス内での重複実行は防止できる
const processedEvents = new Set<string>();
// キャッシュサイズを制限するための管理
const MAX_CACHE_SIZE = 100;
const processedEventsQueue: string[] = [];

// イベントの重複処理を防止する関数
const isEventProcessed = (eventId: string): boolean => {
  if (processedEvents.has(eventId)) {
    console.log(`重複イベントを検出: ${eventId}`);
    return true;
  }
  
  // イベントIDをキャッシュに追加
  processedEvents.add(eventId);
  processedEventsQueue.push(eventId);
  
  // キャッシュサイズを制限
  if (processedEventsQueue.length > MAX_CACHE_SIZE) {
    const oldestEventId = processedEventsQueue.shift();
    if (oldestEventId) processedEvents.delete(oldestEventId);
  }
  
  return false;
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const startTime = Date.now();
  console.log("受信したイベント:", JSON.stringify(event));
  
  // Base64エンコードされたボディを処理
  let rawBody = event.body || '';
  if (event.isBase64Encoded) {
    rawBody = Buffer.from(rawBody, 'base64').toString();
  }
  
  console.log("リクエストボディ:", rawBody);
  
  try {
    const payload = JSON.parse(rawBody);

    // URL検証リクエストの処理
    if (payload.type === "url_verification") {
      console.log("URL検証リクエストを処理します。Challenge:", payload.challenge);
      
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ challenge: payload.challenge })
      };
    }

    // 以下は通常のイベント処理
    const requestType = payload.type as "url_verification" | "event_callback";
    console.log("リクエストタイプ:", requestType);

    // イベントの重複処理を防止（リトライリクエストであっても、まだ処理していなければ実行する）
    if (requestType === "event_callback" && payload.event && payload.event_id) {
      if (isEventProcessed(payload.event_id)) {
        console.log(`イベントID ${payload.event_id} は既に処理済みです。スキップします。`);
        return {
          statusCode: 200,
          body: "Event already processed"
        };
      }
    }

    // AWS Lambdaでは非同期処理が完了するまで待つ必要があるため、
    // バックグラウンド処理をメイン関数内で完了させる
    if (requestType === "event_callback" && payload.event) {
      try {
        // 処理時間測定開始
        const processingTime = Date.now() - startTime;
        console.log(`前処理完了時間: ${processingTime}ms`);
        
        // Lambdaリクエストオブジェクトの変換
        const lambdaRequest = {
          headers: new Headers(Object.entries(event.headers || {}).map(([key, value]) => [key, value?.toString() || '']))
        };

        // リクエストの検証
        const verificationResult = await verifyRequest({ 
          requestType, 
          request: lambdaRequest as any, 
          rawBody 
        });
        
        if (verificationResult) {
          console.error("リクエスト検証エラー");
          return {
            statusCode: 200,
            body: "Verification failed, but returning 200 to avoid retries"
          };
        }

        const botUserId = await getBotId();
        const slackEvent = payload.event as SlackEvent;

        // リトライリクエストであるかをチェック（ログ表示用）
        const isRetry = event.headers && isRetryRequest(event.headers as Record<string, string | undefined>);
        if (isRetry) {
          console.log(`リトライリクエストを処理します: イベントID=${payload.event_id}`);
        }

        // タイムアウト時間の延長: Lambdaのタイムアウトが3分(180秒)なので、
        // 安全マージンを取って160秒(リトライなら120秒)に設定
        const timeoutMs = isRetry ? 120000 : 160000; // 120秒または160秒
        console.log(`タイムアウト時間を設定: ${timeoutMs}ms`);

        // スレッド内で応答中であることを伝える
        try {
          const { WebClient } = require('@slack/web-api');
          const client = new WebClient(process.env.SLACK_BOT_TOKEN);
          
          // メッセージ本文
          const messageText = isRetry 
            ? "再試行中です... (処理は引き続き実行されています)"
            : "考え中です... (処理が完了するまでお待ちください)";

          if (slackEvent.type === "app_mention") {
            await client.chat.postMessage({
              channel: slackEvent.channel,
              thread_ts: slackEvent.thread_ts || slackEvent.ts,
              text: messageText
            });
          }
        } catch (postError) {
          console.error("応答中メッセージの投稿エラー:", postError);
        }

        // イベントタイプに応じた処理
        if (slackEvent.type === "app_mention") {
          console.log("app_mention処理を開始します");
          await Promise.race([
            handleNewAppMention(slackEvent, botUserId),
            createTimeout(timeoutMs)
          ]).catch(error => {
            console.error("処理中にエラーまたはタイムアウトが発生:", error);
            // エラー発生時も応答を送信
            try {
              const { WebClient } = require('@slack/web-api');
              const client = new WebClient(process.env.SLACK_BOT_TOKEN);
              client.chat.postMessage({
                channel: slackEvent.channel,
                thread_ts: slackEvent.thread_ts || slackEvent.ts,
                text: "申し訳ありません、処理中にエラーが発生しました。しばらく経ってからもう一度お試しください。"
              }).catch((e: Error) => console.error("エラーメッセージの送信に失敗:", e));
            } catch (e) {
              console.error("エラー応答の送信に失敗:", e);
            }
          });
          console.log("app_mention処理が完了しました");
        } else if (slackEvent.type === "assistant_thread_started") {
          await Promise.race([
            assistantThreadMessage(slackEvent),
            createTimeout(timeoutMs)
          ]).catch((error: Error) => console.error("assistant_thread_started処理中にエラー:", error));
        } else if (
          slackEvent.type === "message" &&
          !slackEvent.subtype &&
          slackEvent.channel_type === "im" &&
          !slackEvent.bot_id &&
          !slackEvent.bot_profile &&
          slackEvent.bot_id !== botUserId
        ) {
          await Promise.race([
            handleNewAssistantMessage(slackEvent, botUserId),
            createTimeout(timeoutMs)
          ]).catch((error: Error) => console.error("message処理中にエラー:", error));
        }

        const totalTime = Date.now() - startTime;
        console.log(`イベント処理完了: ${totalTime}ms`);
        
        return {
          statusCode: 200,
          body: "処理が完了しました"
        };
      } catch (error) {
        console.error("処理エラー:", error);
        return {
          statusCode: 200, // Slackにはエラーでも200を返して再試行を防ぐ
          body: "Error occurred, but returning 200 to avoid retries"
        };
      }
    }

    return {
      statusCode: 200,
      body: "Success!"
    };
  } catch (error) {
    console.error("エラーが発生しました:", error);
    return {
      statusCode: 500,
      body: "Error processing request: " + (error instanceof Error ? error.message : String(error))
    };
  }
};