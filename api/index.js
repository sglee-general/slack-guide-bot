const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  // 1. 슬랙의 '재시도' 신호는 무조건 바로 통과 (이게 없으면 봇이 꼬입니다)
  if (req.headers['x-slack-retry-num']) {
    return res.status(200).send("ok");
  }

  // 2. URL 검증 (슬랙 연결 유지용)
  if (req.body.type === 'url_verification') {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  const event = req.body.event;
  // 3. 봇에게 온 메시지인지 확인 (멘션 or DM)
  if (event && !event.bot_id && (event.type === 'app_mention' || event.channel_type === 'im')) {
    const channel = event.channel;
    const question = event.text.replace(/<@.*>/, '').trim();

    try {
      // [핵심] Vercel이 중간에 꺼지지 않도록 모든 작업이 끝난 후 응답을 보냅니다.
      // 먼저 "분석 중"이라고 첫 마디를 뱉게 합니다.
      const initialRes = await postToSlack(channel, "🔍 비나우 지식 가이드를 정밀 분석 중입니다. 잠시만 기다려주세요...");
      const ts = initialRes.ts;

      // [핵심] 노션 전체 워크스페이스에서 질문과 관련된 '단어'가 포함된 모든 내용을 찾습니다.
      // 제목이 달라도 본문에 글자만 있으면 찾아냅니다.
      const searchRes = await notion.search({
        query: question,
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: 5
      });

      let knowledgeContext = "";
      for (const page of searchRes.results) {
        if (page.object === 'page') {
          // 페이지 안의 모든 텍스트(표, 리스트 포함)를 읽어옵니다.
          const blocks = await notion.blocks.children.list({ block_id: page.id, page_size: 50 });
          const text = blocks.results
            .map(b => b[b.type]?.rich_text?.map(t => t.plain_text).join("") || "")
            .filter(t => t).join("\n");
          
          knowledgeContext += `### 가이드: ${page.id}\n내용: ${text}\n\n`;
        }
      }

      // [핵심] AI 에이전트가 지식을 읽고 답변 생성
      const answer = await askGeminiAgent(question, knowledgeContext);

      // 답변 수정 (업데이트)
      await updateSlackMessage(channel, ts, answer);
      
      // 모든 작업 완료 후 종료
      return res.status(200).send("ok");

    } catch (error) {
      console.error("에러 발생:", error);
      return res.status(200).send("error");
    }
  }
  return res.status(200).send("ignored");
}

async function askGeminiAgent(question, context) {
  const prompt = `당신은 비나우(BENOW)의 전문 AI 에이전트입니다.
아래 제공된 [사내 지식]을 바탕으로 질문에 답하세요.

[사내 지식]
${context || "관련 정보를 찾지 못했습니다. 봇의 권한을 확인해주세요."}

[질문]
${question}

[지침]
1. 친절한 사내 전문가처럼 답변하세요.
2. 질문과 데이터의 용어가 조금 달라도(wifi-와이파이) 문맥이 같으면 답을 찾으세요.
3. 데이터에 구체적인 비번이나 방법이 있다면 상세히 설명하세요.`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "🤔 가이드 내용을 찾았으나 답변 구성이 어렵습니다. 노션 본문의 글자 정보를 확인해주세요.";
  } catch (e) { return "AI 엔진 응답 중 오류가 발생했습니다."; }
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
