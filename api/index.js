const { Client } = require("@notionhq/client");

// 1. 초기 설정
const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // 슬랙 URL 검증용
  if (req.body.type === 'url_verification') {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  // 슬랙 이벤트(메시지) 수신
  const event = req.body.event;
  if (event && (event.type === 'app_mention' || (event.channel_type === 'im' && !event.bot_id))) {
    
    // 1단계: 슬랙에 "확인 중" 메시지 먼저 보내기 (3초 타임아웃 방지)
    res.status(200).send(""); 
    const initialMsg = await postToSlack(event.channel, "🔍 노션 가이드에서 내용을 찾고 있습니다. 잠시만 기다려주세요...");

    try {
      // 2단계: 노션에서 관련 내용 검색
      const question = event.text.replace(/<@.*>/, '').trim(); // 멘션 태그 제거
      const context = await searchNotionContent(question);

      // 3단계: AI(Gemini)에게 답변 요청
      const answer = await askGemini(question, context);

      // 4단계: 기존 메시지 업데이트 (또는 새 메시지 전송)
      await updateSlackMessage(event.channel, initialMsg.ts, answer);

    } catch (error) {
      console.error("에러 발생:", error);
      await updateSlackMessage(event.channel, initialMsg.ts, "❌ 내용을 찾는 중에 에러가 발생했습니다: " + error.message);
    }
    return;
  }
}

// [노션 검색 함수]
async function searchNotionContent(query) {
  const response = await notion.search({
    query: query,
    filter: { property: 'object', value: 'page' },
    page_size: 3
  });

  let fullContent = "";
  for (const page of response.results) {
    const blocks = await notion.blocks.children.list({ block_id: page.id });
    const text = blocks.results
      .filter(b => b.type === 'paragraph')
      .map(b => b.paragraph.rich_text.map(t => t.plain_text).join(""))
      .join("\n");
    fullContent += `[페이지: ${page.properties.title?.title[0]?.plain_text || "제목없음"}]\n${text}\n\n`;
  }
  return fullContent || "관련 가이드 내용을 찾을 수 없습니다.";
}

// [Gemini AI 답변 함수]
async function askGemini(question, context) {
  const prompt = `당신은 비나우(BENOW)의 업무 가이드 안내 봇입니다. 
아래 제공된 [노션 가이드 내용]을 바탕으로 사용자의 질문에 친절하게 답변하세요. 
내용에 없는 정보라면 억지로 만들지 말고 모른다고 답변하세요.

[노션 가이드 내용]:
${context}

[사용자 질문]:
${question}`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
}

// [슬랙 유틸리티 함수들]
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
