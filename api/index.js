const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  // 1. 슬랙 재시도 신호 차단 (매우 중요)
  if (req.headers['x-slack-retry-num']) return res.status(200).send("ok");
  if (req.body.type === 'url_verification') return res.status(200).json({ challenge: req.body.challenge });

  const event = req.body.event;
  if (event && !event.bot_id && (event.type === 'app_mention' || event.channel_type === 'im')) {
    // 일단 슬랙에 "확인했어"라고 응답을 보내 프로세스를 안정화합니다.
    res.status(200).send("ok");

    const channel = event.channel;
    const question = event.text.replace(/<@.*>/, '').trim();

    try {
      // (1) 첫 반응: 에이전트 느낌 팍팍 내기
      const initialRes = await postToSlack(channel, "🚀 **비나우 지식 베이스를 정렬하고 답변을 생성 중입니다...**");
      const ts = initialRes.ts;

      // (2) [핵심] 노션 딥-스캔: 모든 종류의 텍스트 블록 추출
      const context = await getNotionDeepContent(question);
      
      // (3) AI(Gemini)에게 지식 주입 및 답변 생성
      const answer = await askGeminiExpert(question, context);

      // (4) 답변 업데이트
      await updateSlackMessage(channel, ts, answer);
    } catch (error) {
      console.error("Critical Error:", error);
    }
  }
}

// 노션의 모든 텍스트 블록을 긁어오는 함수
async function getNotionDeepContent(query) {
  try {
    const searchRes = await notion.search({ query, page_size: 3 });
    let fullContext = "";

    for (const page of searchRes.results) {
      if (page.object === 'page') {
        const blocks = await notion.blocks.children.list({ block_id: page.id });
        const pageText = blocks.results
          .map(block => {
            const type = block.type;
            const richText = block[type]?.rich_text || [];
            return richText.map(t => t.plain_text).join("");
          })
          .filter(t => t.length > 0).join("\n");
        
        fullContext += `\n[가이드: ${page.id}]\n${pageText}\n`;
      }
    }
    return fullContext;
  } catch (e) { return ""; }
}

async function askGeminiExpert(question, context) {
  // 만약 노션에서 가져온 데이터가 너무 부실할 경우 AI에게 경고를 줍니다.
  const prompt = `당신은 비나우(BENOW)의 전문 AI 업무 에이전트입니다. 
제공된 [사내 가이드]를 기반으로 답변하세요.

[사내 가이드]
${context || "가이드 내용이 비어있습니다. 사용자가 직접 페이지를 확인하게 하세요."}

[질문]
${question}

[답변 원칙]
1. 가이드에 wifi 비밀번호, 주차 등록법, 택배 위치 등이 있다면 절대 누락하지 마세요.
2. 질문과 용어가 조금 달라도(와이파이-wifi) 같은 의미라면 답변하세요.
3. 데이터가 정말 없다면 "죄송합니다. 현재 가이드에는 관련 내용이 없습니다."라고 정중히 답하세요.`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "🤔 가이드를 분석했으나 답변 구성에 실패했습니다. 노션 본문을 확인해 주세요.";
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
