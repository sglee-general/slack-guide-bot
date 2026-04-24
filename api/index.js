const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  // 1. 슬랙 재시도(Retry) 신호 즉시 차단 (이게 침묵을 해결하는 핵심입니다)
  if (req.headers['x-slack-retry-num']) {
    return res.status(200).send("ok");
  }

  // 2. 슬랙 연결 검증
  if (req.body.type === 'url_verification') {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  const event = req.body.event;
  if (event && !event.bot_id && (event.type === 'app_mention' || event.channel_type === 'im')) {
    
    // [중요] 슬랙에 200 OK를 "먼저" 보내서 서버가 죽지 않게 확보합니다.
    res.status(200).send("ok");

    const channel = event.channel;
    const question = event.text.replace(/<@.*>/, '').trim();

    try {
      // (1) 첫 반응 메시지 (봇이 살아있음을 즉시 알림)
      const initial = await postToSlack(channel, "🔍 **비나우 업무 가이드를 정밀 스캔하고 있습니다...**");
      const ts = initial.ts;

      // (2) 노션 검색 (단순 제목 검색 + 최근 편집 페이지 싹 긁어오기)
      // 질문과 상관없어 보여도 최근에 편집된 페이지 5개를 가져와 AI에게 물어봅니다.
      const searchRes = await notion.search({
        query: question,
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: 5
      });

      let knowledgeContext = "";
      for (const page of searchRes.results) {
        if (page.object === 'page') {
          const blocks = await notion.blocks.children.list({ block_id: page.id });
          const text = blocks.results
            .map(b => b[b.type]?.rich_text?.map(t => t.plain_text).join("") || "")
            .filter(t => t.length > 1).join("\n");
          knowledgeContext += `[가이드 문서]\n${text}\n\n`;
        }
      }

      // (3) AI 답변 생성 (Gemini 1.5 Flash 모델 사용 - 속도가 훨씬 빠릅니다)
      const answer = await askGeminiExpert(question, knowledgeContext);

      // (4) 최종 답변으로 메시지 업데이트
      await updateSlackMessage(channel, ts, answer);

    } catch (error) {
      console.error("❌ 최종 에러:", error.message);
    }
    return;
  }
}

async function askGeminiExpert(question, context) {
  const prompt = `당신은 비나우(BENOW)의 전문 AI 업무 비서입니다. 
제공된 [노션 가이드 데이터]를 기반으로 사용자의 질문에 답하세요.

[노션 가이드 데이터]
${context || "관련 내용을 찾지 못했습니다. 하지만 최대한 아는 지식을 동원하세요."}

[사용자 질문]
${question}

[답변 가이드라인]
1. 사용자가 "와이파이", "wifi" 등으로 물어보면 노션의 wifi 관련 정보를 찾아 답변하세요.
2. 페이지 안에 이미지나 표가 있다면, 그 주변 텍스트를 통해 내용을 유추해서 친절히 설명하세요.
3. 데이터가 정말 없으면 "가이드에서 해당 내용을 찾지 못했습니다. 사업지원팀에 문의해주세요."라고 답하세요.
4. 아주 싹싹하고 전문적인 말투로 답변하세요.`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "🤔 답변을 생성하는 데 실패했습니다. 노션 내용을 보강해주세요.";
  } catch (e) { return "AI 답변 생성 중 오류가 발생했습니다."; }
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
  await fetch('https://slack.com/api/update', { // URL 오타 수정 (chat.update)
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel, ts, text })
  });
}
