import { WebClient } from '@slack/web-api';
import { CoreMessage } from 'ai'
import crypto from 'crypto'

const signingSecret = process.env.SLACK_SIGNING_SECRET!

export const client = new WebClient(process.env.SLACK_BOT_TOKEN);

// Slackリクエストの検証（Lambda環境用に最適化）
export async function isValidSlackRequest({
  request,
  rawBody,
}: {
  request: { headers: Record<string, string> }
  rawBody: string
}) {
  // ヘッダーを取得（大文字小文字を区別せずアクセスできるように）
  const getHeader = (name: string): string | undefined => {
    const lowerName = name.toLowerCase();
    const key = Object.keys(request.headers).find(k => k.toLowerCase() === lowerName);
    return key ? request.headers[key] : undefined;
  };

  const timestamp = getHeader('X-Slack-Request-Timestamp');
  const slackSignature = getHeader('X-Slack-Signature');

  if (!timestamp || !slackSignature) {
    console.log('Missing timestamp or signature');
    return false;
  }

  // Prevent replay attacks on the order of 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 60 * 5) {
    console.log('Timestamp out of range');
    return false;
  }

  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto
    .createHmac('sha256', signingSecret)
    .update(base)
    .digest('hex');
  const computedSignature = `v0=${hmac}`;

  try {
    // Prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(computedSignature),
      Buffer.from(slackSignature)
    );
  } catch (error) {
    console.error('署名検証中にエラーが発生しました:', error);
    return false;
  }
}

// Lambda環境用にverifyRequest関数を修正（Responseオブジェクトを返さない）
export const verifyRequest = async ({
  requestType,
  request,
  rawBody,
}: {
  requestType: string;
  request: { headers: Record<string, string> };
  rawBody: string;
}) => {
  try {
    const validRequest = await isValidSlackRequest({ request, rawBody });
    if (!validRequest || requestType !== "event_callback") {
      console.error("不正なリクエストまたはevent_callbackではありません");
      return true; // エラーを示す値として真を返す
    }
    return false; // 検証成功
  } catch (error) {
    console.error("リクエスト検証中にエラーが発生しました:", error);
    return true; // エラーが発生した場合も検証失敗として扱う
  }
};

// イベントが既に応答済みかをチェックする関数
export async function checkIfAlreadyResponded(event: any): Promise<boolean> {
  // channel と ts プロパティを持つイベントのみ処理
  if (!('channel' in event && 'ts' in event)) {
    console.log('チャンネルかタイムスタンプが不明なイベント - 重複チェックはスキップします');
    return false;
  }

  try {
    // スレッド内のメッセージを取得
    const threadTs = 'thread_ts' in event && event.thread_ts ? event.thread_ts : event.ts;
    const { messages } = await client.conversations.replies({
      channel: event.channel,
      ts: threadTs,
      limit: 10, // 直近のメッセージのみを確認
    });

    if (!messages || messages.length <= 1) {
      return false; // メッセージがない場合は処理続行
    }

    // ボットのIDを取得
    const { bot_id: botId } = await client.auth.test();

    // ボットからの返信があるか確認
    // イベントのタイムスタンプより後のボットのメッセージを探す
    const botMessages = messages.filter((m: any) => 
      m.bot_id === botId && 
      m.thread_ts === threadTs &&
      parseFloat(m.ts) > parseFloat(event.ts)
    );

    if (botMessages.length > 0) {
      console.log(`既存の応答を検出: ${botMessages.length}件のボットメッセージがあります`);
      return true;
    }

    return false;
  } catch (error) {
    console.error('応答チェック中にエラーが発生しました:', error);
    // エラー発生時は安全のため処理を継続
    return false;
  }
}

export const updateStatusUtil = (channel: string, thread_ts: string) => {
  return async (status: string) => {
    try {
      // client.assistant.threads.setStatusの代わりにchat.postMessageを使用
      await client.chat.postMessage({
        channel: channel,
        thread_ts: thread_ts,
        text: status,
      });
    } catch (error) {
      console.error("ステータス更新中にエラーが発生しました:", error);
    }
  };
};

export async function getThread(
  channel_id: string,
  thread_ts: string,
  botUserId: string,
): Promise<CoreMessage[]> {
  try {
    const { messages } = await client.conversations.replies({
      channel: channel_id,
      ts: thread_ts,
      limit: 50,
    });

    // Ensure we have messages
    if (!messages) throw new Error("No messages found in thread");

    const result = messages
      .map((message) => {
        const isBot = !!message.bot_id;
        if (!message.text) return null;

        // For app mentions, remove the mention prefix
        // For IM messages, keep the full text
        let content = message.text;
        if (!isBot && content.includes(`<@${botUserId}>`)) {
          content = content.replace(`<@${botUserId}> `, "");
        }

        return {
          role: isBot ? "assistant" : "user",
          content: content,
        } as CoreMessage;
      })
      .filter((msg): msg is CoreMessage => msg !== null);

    return result;
  } catch (error: any) {
    console.error(`スレッド履歴の取得中にエラーが発生しました: ${error.message}`);
    
    // missing_scopeエラーの場合、権限不足メッセージを返す
    if (error.data && error.data.error === 'missing_scope') {
      console.error(`必要なスコープ: ${error.data.needed}, 提供されたスコープ: ${error.data.provided}`);
      // 最低限のメッセージ履歴（現在のメッセージのみ）を返す
      return [{
        role: "user",
        content: "すみません、プライベートチャンネルの履歴を読み取る権限がありません。管理者にgroups:historyスコープの追加を依頼してください。"
      }];
    }
    
    // その他のエラーの場合はエラーメッセージを含むレスポンスを返す
    return [{
      role: "user",
      content: `エラーが発生しました: ${error.message || "不明なエラー"}`
    }];
  }
};

export const getBotId = async () => {
  try {
    const { user_id: botUserId } = await client.auth.test();

    if (!botUserId) {
      throw new Error("botUserId is undefined");
    }
    return botUserId;
  } catch (error) {
    console.error("ボットID取得中にエラーが発生しました:", error);
    throw error; // 上位の呼び出し元でハンドリングするためにエラーを再スロー
  }
};
