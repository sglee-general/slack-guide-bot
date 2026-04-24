const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  // 1. 슬랙 재시도 신호 즉시 차단
  if (req.headers['x-slack-retry-num']) return res.status(200).send("ok");

  // 2. URL 검증
  if (req.body.type === 'url_verification') return res.status(200).json({ challenge: req.body.challenge });

  const event = req.body.event;
  if (event && !event.bot_id && (event.type === 'app_mention' || event.channel_type === 'im')) {
    
    // [핵심] Vercel이 종료되지 않도록res.status(200)을 보내기 전에 모든 비동기 로직을 감쌉니다.
    // 하지만 슬랙 3초 제한을 피하기 위해 일단 응답은 보냅니다.
    res.status(200).send("ok");

    const channel = event.channel;
    const question = event.text.replace(/<@.*>/, '').trim();
    let ts = "";

    try {
      // (1) 첫 반응 전송
      const initialRes = await postToSlack(channel, "🧠 비나우 AI 에이전트가 노션 가이드를 정밀 분석 중입니다...");
      ts = initialRes.ts;

      // (2) 노션 검색 (notion.search는 하위 페이지까지 몽땅 검색합니다!)
      // 페이지 제목뿐만 아니라 '단어'가 포함된 모든 곳을 찾습니다.
      const searchRes = await notion.search({
        query: question,
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: 5
      });

      let knowledge = "";
      if (searchRes.results.length > 0) {
        for (const page of searchRes.results) {
          if (page.object === 'page') {
            const blocks = await notion.blocks.children.list({ block_id: page.id, page_size: 20 });
            const pageText = blocks.results
              .map(b => b[b.type]?.rich_text?.map(t => t.plain_text).join("") || "")
              .join(" ");
            knowledge += `[가이드: ${page.id}] ${pageText}\n`;
          }
        }
      }

      // (3) AI(Gemini)에게 에이전트 역할 부여
      const answer = await askGeminiAgent(question, knowledge);

      // (4) 답변 업데이트
      await updateSlackMessage(channel, ts, answer);

    } catch (error) {
      console.error("실행 에러:", error);
      if (ts) await updateSlackMessage(channel, ts, `❌ 오류가 발생했어요: ${error.message}`);
    }
    return;
  }
}

async function askGeminiAgent(question, context) {
  const prompt = `당신은 비나우(BENOW)의 업무 가이드 에이전트입니다.
제공된 [사내 지식 데이터]를 바탕으로 질문에 답하세요.

[사내 지식 데이터]
${context || "관련 내용을 찾지 못했습니다."}

[질문]
${question}

[지침]
1. 자연어 질문(예: 주차 어떻게 해?)을 받으면 지식 데이터에서 '주차' 관련 내용을 찾아 요약하세요.
2. 데이터가 부족해도 아는 범위 내에서 최대한 친절히 답하고, 모르면 사업지원팀을 안내하세요.
3. 답변은 간결하고 명확하게, 슬랙 메시지 형식으로 작성하세요.`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "🤔 답변을 구성할 지식이 부족합니다. 노션 가이드를 확인해 주세요.";
  } catch (e) { return "AI 엔진 호출 실패"; }
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
