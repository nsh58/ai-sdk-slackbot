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

export const generateResponse = async (
  messages: CoreMessage[],
  updateStatus?: (status: string) => void,
) => {
  const { text } = await generateText({
    model: anthropic("claude-3-5-haiku-20241022"),
    system: `You are a Slack bot assistant Keep your responses concise and to the point.
    - Do not tag users.
    - Current date is: ${new Date().toISOString().split("T")[0]}
    - Make sure to ALWAYS include sources in your final response if you use web search. Put sources inline if possible.`,
    messages,
    maxSteps: 10,
    tools: {
      getBacklogWikiContent: tool({
        description: "Backlog Wikiの内容を取得",
        parameters: z.object({
          wikiId: z.string().describe("取得するWikiページのID")
        }),
        execute: async ({ wikiId }) => {
          updateStatus?.(`Backlog WikiID: ${wikiId} の内容を取得中...`);
          
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
          updateStatus?.(`キーワード "${keyword}" でBacklog Wikiを検索中...`);
          
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
