const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  // 1. 슬랙 재시도 신호 무시 (중복 실행 방지)
  if (req.headers['x-slack-retry-num']) return res.status(200).send("ok");
  if (req.body.type === 'url_verification') return res.status(200).json({ challenge: req.body.challenge });

  const event = req.body.event;
  if (event && !event.bot_id && (event.type === 'app_mention' || event.channel_type === 'im')) {
    const channel = event.channel;
    const question = event.text.replace(/<@.*>/, '').trim();

    try {
      // (1) 첫 반응 전송 (연결 확인용)
      const initial = await postToSlack(channel, "🔍 **가이드 본문 텍스트 스캔 중... 잠시만 기다려 주세요.**");
      const ts = initial.ts;

      // (2) 노션 검색 및 데이터 추출
      const searchRes = await notion.search({ query: question, page_size: 1 });
      let knowledgeBase = "";

      if (searchRes.results.length > 0) {
        const pageId = searchRes.results[0].id;
        // 페이지의 모든 블록을 싹 긁어모음 (표 밖의 텍스트 포함)
        const blocks = await notion.blocks.children.list({ block_id: pageId, page_size: 50 });
        knowledgeBase = blocks.results
          .map(b => {
            const type = b.type;
            const richText = b[type]?.rich_text || [];
            return richText.map(t => t.plain_text).join("");
          })
          .filter(t => t.trim().length > 0)
          .join("\n");
      }

      // (3) AI 답변 생성 (가장 정확한 1.5-flash 모델)
      const answer = await askAI(question, knowledgeBase);

      // (4) 답변 업데이트 (이 작업이 끝날 때까지 서버는 살아있습니다)
      await updateSlackMessage(channel, ts, answer);
      
      // [핵심] 모든 일이 "완전하게" 끝난 후에만 응답을 보냅니다.
      return res.status(200).send("ok");

    } catch (error) {
      console.error("에러 발생:", error.message);
      return res.status(200).send("ok"); // 에러가 나도 슬랙 재시도는 막아야 함
    }
  }
}

async function askAI(question, context) {
  const prompt = `비나우(BENOW) 전문 에이전트입니다. 아래 노션 지식을 바탕으로 질문에 답하세요.
불렛 포인트나 일반 텍스트에 적힌 비밀번호(PW), SSID 정보를 절대 놓치지 마세요.
[지식]: ${context || "내용을 읽지 못했습니다."}
[질문]: ${question}`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "🤔 가이드는 읽었으나 답변 구성에 실패했습니다.";
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
