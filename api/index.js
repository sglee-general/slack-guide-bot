const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  // 1. 슬랙의 신호를 받았는지 로그로 확인
  console.log("📨 신호 수신:", JSON.stringify(req.body));

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  if (req.body.type === 'url_verification') {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  const event = req.body.event;
  // 봇 본인의 메시지에는 반응하지 않도록 필터링
  if (event && !event.bot_id && (event.type === 'app_mention' || event.channel_type === 'im')) {
    
    try {
      const channel = event.channel;
      const question = event.text.replace(/<@.*>/, '').trim();
      console.log("❓ 질문 발견:", question);

      // [핵심 수정] Vercel이 잠들지 않도록 모든 작업을 마친 후 응답을 보냅니다.
      
      // 1. 먼저 "찾는 중" 메시지 보내기
      const initialRes = await postToSlack(channel, "🔍 노션 가이드를 확인하고 있습니다. 잠시만요...");
      const ts = initialRes.ts;

      // 2. 노션 검색
      console.log("📚 노션 뒤지는 중...");
      const context = await searchNotionContent(question);

      // 3. AI 답변 생성
      console.log("🤖 AI 생각 중...");
      const answer = await askGemini(question, context);

      // 4. 슬랙 메시지 수정하여 답변 완료
      await updateSlackMessage(channel, ts, answer);
      console.log("✅ 답변 전송 완료!");

      // 모든 작업이 끝난 뒤에 OK를 보냅니다.
      return res.status(200).send("ok");

    } catch (error) {
      console.error("❌ 에러 발생 상세:", error);
      // 에러가 나면 슬랙에 알려주기
      await postToSlack(event.channel, "😭 죄송해요. 오류가 발생했어요: " + error.message);
      return res.status(200).send("error");
    }
  }

  return res.status(200).send("ignored");
}

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
    fullContent += `[가이드: ${page.properties.title?.title[0]?.plain_text || "내용"}]\n${text}\n\n`;
  }
  return fullContent || "관련 내용을 노션에서 찾지 못했습니다.";
}

async function askGemini(question, context) {
  const prompt = `비나우 업무 가이드 봇입니다. 아래 노션 내용을 바탕으로 답변하세요.\n\n[노션 내용]:\n${context}\n\n[질문]:\n${question}`;
  
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
}

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
