const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  // 1. 슬랙 재시도(Retry) 무시 - 이미 처리 중이면 중복 응답하지 않음
  if (req.headers['x-slack-retry-num']) {
    return res.status(200).send("ok");
  }

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  if (req.body.type === 'url_verification') {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  const event = req.body.event;
  if (event && !event.bot_id && (event.type === 'app_mention' || event.channel_type === 'im')) {
    
    // 비동기로 작업을 처리하고 슬랙에는 일단 200 OK를 빨리 줍니다 (3초 타임아웃 방지)
    res.status(200).send("ok");

    try {
      const channel = event.channel;
      const question = event.text.replace(/<@.*>/, '').trim();

      // 1. 찾는 중 메시지 보내기
      const initialRes = await postToSlack(channel, "🔍 노션 가이드에서 내용을 찾고 있습니다. 잠시만 기다려주세요...");
      const ts = initialRes.ts;

      // 2. 노션 검색 (데이터가 없을 때를 대비해 안전하게 수정)
      const context = await searchNotionContent(question);

      // 3. AI 답변 생성 (Gemini 응답 구조를 아주 안전하게 접근)
      const answer = await askGemini(question, context);

      // 4. 답변 업데이트
      await updateSlackMessage(channel, ts, answer);

    } catch (error) {
      console.error("상세 에러:", error);
    }
    return;
  }
}

// [안전한 노션 검색]
async function searchNotionContent(query) {
  try {
    const response = await notion.search({
      query: query,
      filter: { property: 'object', value: 'page' },
      page_size: 3
    });
    
    if (!response.results || response.results.length === 0) return "관련 정보를 노션에서 찾을 수 없습니다.";

    let fullContent = "";
    for (const page of response.results) {
      const blocks = await notion.blocks.children.list({ block_id: page.id });
      // 제목 가져오기 (다양한 노션 속성 이름 대응)
      const titleObj = page.properties?.title || page.properties?.Name || page.properties?.제목;
      const title = titleObj?.title?.[0]?.plain_text || "제목 없음";
      
      const text = blocks.results
        .filter(b => b.type === 'paragraph')
        .map(b => b.paragraph.rich_text?.map(t => t.plain_text).join("") || "")
        .join("\n");
      fullContent += `[페이지: ${title}]\n${text}\n\n`;
    }
    return fullContent;
  } catch (e) {
    return "노션 데이터를 읽어오지 못했습니다.";
  }
}

// [안전한 Gemini 답변]
async function askGemini(question, context) {
  try {
    const prompt = `비나우(BENOW) 업무 가이드 봇입니다. 다음 노션 내용을 바탕으로 답변하세요.\n\n[노션]:\n${context}\n\n[질문]:\n${question}`;
    
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const data = await res.json();
    
    // [핵심 수정] 여기서 'reading 0' 에러가 나지 않도록 단계별로 체크합니다.
    if (data.candidates && data.candidates.length > 0 && data.candidates[0].content?.parts?.[0]?.text) {
      return data.candidates[0].content.parts[0].text;
    } else {
      return "AI가 답변을 생성하지 못했습니다. (API 응답 오류)";
    }
  } catch (e) {
    return "AI와 대화 중 오류가 발생했습니다.";
  }
}

// 슬랙 유틸 함수들
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
