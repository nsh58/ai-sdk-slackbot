import { anthropic } from "@ai-sdk/anthropic";
import { CoreMessage, generateText, tool } from "ai";
import { z } from "zod";
import { exa } from "./utils";

// Backlog Wikiの型定義
interface BacklogWiki {
  id: string;
  name: string;
  updated: string;
  projectId: string;
}

// Backlog Wiki内容の型定義
interface BacklogWikiContent {
  name: string;
  updated: string;
  updatedUser: string | null;
  content: string;
}

// 状態更新のスロットリング用変数
const lastUpdateTime: { [key: string]: number } = {};
const UPDATE_INTERVAL = 2000; // ミリ秒単位（2秒）

// 最適化された状態更新関数
const throttledUpdate = (
  updateStatus?: (status: string) => void,
  operationId: string = 'default'
) => {
  return (message: string) => {
    const now = Date.now();
    // 前回の更新から一定時間経過していない場合はスキップ
    if (lastUpdateTime[operationId] && now - lastUpdateTime[operationId] < UPDATE_INTERVAL) {
      return;
    }
    
    lastUpdateTime[operationId] = now;
    updateStatus?.(message);
  };
};

export const generateResponse = async (
  messages: CoreMessage[],
  updateStatus?: (status: string) => void,
) => {
  // 新しいスロットリングされた更新関数
  const throttledUpdateStatus = throttledUpdate(updateStatus);
  
  // 処理開始メッセージ - 一回だけ送信
  throttledUpdateStatus("考え中...");

  const { text } = await generateText({
    model: anthropic("claude-3-5-haiku-20241022"),
    system: `あなたは日本語でのSlack botアシスタントです。回答は簡潔かつ要点をついたものにしてください。
    
    - 現在の日付: ${new Date().toISOString().split("T")[0]}
    - ユーザーにメンションを付けないでください
    
    # Backlog Wiki検索と情報取得のプロセス
    ユーザーからの質問に対して、以下の手順で情報を収集して回答してください：
    
    1. まず、「searchBacklogWiki」ツールを使って関連するWikiページを検索してください
    2. 検索結果があれば、最も関連性の高いWikiページを特定し、「getBacklogWikiContent」ツールでその内容を取得してください
    3. 取得したWiki内容に基づいて質問に回答してください
    4. 情報源として、参照したWikiページのタイトルを回答に含めてください
    
    情報が見つからない場合のみ「関連する情報が見つかりませんでした」と回答してください。
    
    # キーワード抽出のポイント
    - 「部費」→「部費」「部活動」「費用」などのキーワードで検索
    - 「イベント」「日程」→「イベント」「スケジュール」「カレンダー」などで検索
    - 「ルール」「規則」→「ルール」「規約」「ガイドライン」などで検索
    
    検索結果は必ず確認し、適切なWikiページの内容を取得してから回答してください。`,
    messages,
    maxSteps: 10,
    tools: {
      getBacklogWikiContent: tool({
        description: "Backlog Wikiの内容を取得",
        parameters: z.object({
          wikiId: z.string().describe("取得するWikiページのID")
        }),
        execute: async ({ wikiId }) => {
          // スロットリングされた更新関数を使用
          throttledUpdateStatus(`Backlog WikiID: ${wikiId} の内容を取得中...`);
          
          const wiki = await fetchBacklogWikiContent(wikiId);
          return {
            name: wiki.name,
            updated: wiki.updated,
            updatedUser: wiki.updatedUser,
            content: wiki.content
          };
        },
      }),
      searchBacklogWiki: tool({
        description: "Backlog Wiki をキーワードで検索",
        parameters: z.object({
          keyword: z.string(),
          projectId: z.string().optional(),
          maxResults: z.number().default(10),
        }),
        execute: async ({ keyword, projectId, maxResults }) => {
          // スロットリングされた更新関数を使用
          throttledUpdateStatus(`キーワード "${keyword}" でBacklog Wikiを検索中...`);
          
          const results = await fetchSearchWiki(keyword, projectId, maxResults);
          return results.map((wiki: BacklogWiki) => ({
            id: wiki.id,
            name: wiki.name,
            updated: wiki.updated,
            projectId: wiki.projectId,
          }));
        },
      }),
    },
  });

  // Convert markdown to Slack mrkdwn format
  return text.replace(/\[(.*?)\]\((.*?)\)/g, "<$2|$1>").replace(/\*\*/g, "*");
};

// Backlog Wiki検索関数
export const fetchSearchWiki = async (
  keyword: string, 
  projectId?: string, 
  maxResults: number = 10
): Promise<BacklogWiki[]> => {
  const SPACE_ID = process.env.BACKLOG_SPACE_ID;
  const API_KEY = process.env.BACKLOG_API_KEY;
  const DEFAULT_PROJECT_ID = process.env.BACKLOG_PROJECT_ID;

  if (!SPACE_ID || !API_KEY) {
    throw new Error("環境変数 BACKLOG_SPACE_ID または BACKLOG_API_KEY が未設定です");
  }

  // URLパラメータを構築
  const params = new URLSearchParams();
  params.append("apiKey", API_KEY);
  
  // キーワードが指定されている場合は追加
  if (keyword) {
    params.append("keyword", keyword);
  }
  
  // 結果数を指定
  params.append("count", maxResults.toString());
  
  // プロジェクトIDを指定（指定がない場合はデフォルト値を使用）
  const projectIdToUse = projectId || DEFAULT_PROJECT_ID;
  if (projectIdToUse) {
    params.append("projectIdOrKey", projectIdToUse);
  }

  const url = `https://${SPACE_ID}.backlog.com/api/v2/wikis?${params.toString()}`;

  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Backlog API エラー (${response.status}): ${text}`);
  }

  const data = await response.json();

  return data.map((wiki: any) => ({
    id: wiki.id,
    name: wiki.name,
    updated: wiki.updated,
    projectId: wiki.projectId,
  }));
};

// Backlog Wiki内容取得関数
export const fetchBacklogWikiContent = async (wikiId: string): Promise<BacklogWikiContent> => {
  const SPACE_ID = process.env.BACKLOG_SPACE_ID;
  const API_KEY = process.env.BACKLOG_API_KEY;

  if (!SPACE_ID || !API_KEY) {
    throw new Error("環境変数 BACKLOG_SPACE_ID または BACKLOG_API_KEY が未設定です");
  }

  const url = `https://${SPACE_ID}.backlog.com/api/v2/wikis/${wikiId}?apiKey=${API_KEY}`;

  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Backlog API エラー (${response.status}): ${text}`);
  }

  const data = await response.json();

  return {
    name: data.name,
    updated: data.updated,
    updatedUser: data.updatedUser?.name,
    content: (data.content || "").trim(),
  };
};
