import { AppMentionEvent } from "@slack/web-api";
import { client, getThread } from "./slack-utils";
import { generateResponse } from "./generate-response";

const updateStatusUtil = async (
  initialStatus: string,
  event: AppMentionEvent,
) => {
  // 既存のメッセージがある場合は更新するだけにするためのフラグ
  const initialMessageIdKey = `message_${event.channel}_${event.thread_ts || event.ts}`;
  // @ts-ignore
  if (global[initialMessageIdKey]) {
    return async (status: string) => {
      try {
        // @ts-ignore
        await client.chat.update({
          channel: event.channel,
          // @ts-ignore
          ts: global[initialMessageIdKey],
          text: status,
        });
      } catch (error) {
        console.error("メッセージ更新エラー:", error);
      }
    };
  }

  // 新しいメッセージを送信
  try {
    const initialMessage = await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts ?? event.ts,
      text: initialStatus,
    });

    if (!initialMessage || !initialMessage.ts)
      throw new Error("Failed to post initial message");

    // メッセージIDをグローバルに保存
    // @ts-ignore
    global[initialMessageIdKey] = initialMessage.ts;

    const updateMessage = async (status: string) => {
      if (!status) return; // 空のステータスは更新しない
      
      try {
        await client.chat.update({
          channel: event.channel,
          ts: initialMessage.ts as string,
          text: status,
        });
      } catch (updateError) {
        console.error("メッセージ更新エラー:", updateError);
      }
    };
    return updateMessage;
  } catch (error) {
    console.error("初期メッセージ送信エラー:", error);
    // フォールバック用の空の更新関数
    return async (_: string) => {};
  }
};

export async function handleNewAppMention(
  event: AppMentionEvent,
  botUserId: string,
) {
  console.log("Handling app mention");
  if (event.bot_id || event.bot_id === botUserId || event.bot_profile) {
    console.log("Skipping app mention from bot");
    return;
  }

  const { thread_ts, channel } = event;
  
  // デバッグログ追加
  console.log(`メッセージ処理開始 - チャンネル: ${channel}, スレッド: ${thread_ts || "新規スレッド"}`);
  
  // 更新関数を取得
  const updateMessage = await updateStatusUtil("処理中...", event);

  try {
    let result: string;
    
    if (thread_ts) {
      console.log("スレッド内メッセージとして処理");
      const messages = await getThread(channel, thread_ts, botUserId);
      result = await generateResponse(messages, updateMessage);
    } else {
      console.log("新規メッセージとして処理");
      result = await generateResponse(
        [{ role: "user", content: event.text }],
        updateMessage,
      );
    }
    
    // 最終的な応答だけを送信（中間状態の更新は省略）
    await updateMessage(result);
    console.log("メッセージ処理完了");
  } catch (error) {
    console.error("メッセージ処理エラー:", error);
    await updateMessage("処理中にエラーが発生しました。しばらく経ってから再度お試しください。");
  }
}
