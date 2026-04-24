const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  if (req.headers['x-slack-retry-num']) return res.status(200).send("ok");
  if (req.body.type === 'url_verification') return res.status(200).json({ challenge: req.body.challenge });

  const event = req.body.event;
  if (event && !event.bot_id && (event.type === 'app_mention' || event.channel_type === 'im')) {
    res.status(200).send("ok");

    try {
      const channel = event.channel;
      const question = event.text.replace(/<@.*>/, '').trim();

      const initialRes = await postToSlack(channel, "🧠 비나우 가이드 지도를 펼쳐서 내용을 찾는 중입니다...");
      const ts = initialRes.ts;

      // [1단계] 최상위 페이지의 하위 페이지 목록(지도)을 가져옴
      const pageMap = await getNotionMap(process.env.NOTION_PAGE_ID);
      
      // [2단계] AI가 어떤 페이지를 읽을지 선택
      const targetPageId = await askAIToChoosePage(question, pageMap);
      
      let context = "";
      if (targetPageId) {
        // [3단계] 선택된 페이지의 상세 내용을 읽음
        context = await getPageContent(targetPageId);
      } else {
        // AI가 못 찾으면 전체 검색이라도 시도
        context = await fallbackSearch(question);
      }

      // [4단계] 최종 답변 생성
      const answer = await askGeminiFinal(question, context);
      await updateSlackMessage(channel, ts, answer);

    } catch (error) {
      console.error("에러:", error);
    }
  }
}

// 노션 하위 페이지들의 제목과 ID를 싹 긁어오는 함수
async function getNotionMap(rootId) {
  const response = await notion.blocks.children.list({ block_id: rootId });
  return response.results
    .filter(b => b.type === 'child_page')
    .map(b => ({ id: b.id, title: b.child_page.title }));
}

// AI가 질문을 보고 어떤 페이지로 들어갈지 결정하는 함수
async function askAIToChoosePage(question, pageMap) {
  const mapText = pageMap.map(p => `- ${p.title} (ID: ${p.id})`).join("\n");
  const prompt = `사용자 질문: "${question}"\n\n아래 노션 페이지 목록 중 질문과 가장 연관 있는 페이지의 ID만 딱 하나 골라줘. 없으면 "NONE"이라고 답해.\n\n${mapText}`;
  
  const res = await callGemini(prompt);
  const match = res.match(/[a-f0-9-]{36}/); // UUID 형식 추출
  return match ? match[0] : null;
}

// 선택된 페이지의 본문을 읽어오는 함수
async function getPageContent(pageId) {
  const blocks = await notion.blocks.children.list({ block_id: pageId });
  return blocks.results
    .map(b => b[b.type]?.rich_text?.map(t => t.plain_text).join("") || "")
    .filter(t => t).join("\n");
}

// AI 호출 기본 함수
async function callGemini(prompt) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function askGeminiFinal(question, context) {
  const prompt = `당신은 비나우 에이전트입니다. 아래 노션 지식을 바탕으로 질문에 답하세요.\n\n[지식]:\n${context}\n\n[질문]:\n${question}`;
  return await callGemini(prompt);
}

// 보조 검색 기능
async function fallbackSearch(query) {
  const res = await notion.search({ query, page_size: 3 });
  return res.results.map(p => p.id).join(", "); // 간단히 구현
}

// 슬랙 유틸리티 (기존과 동일)
async function postToSlack(channel, text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel, text })
  });
  return await res.json();
}

async function updateSlackMessage(channel, ts, text) {
  await fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel, ts, text })
  });
}
