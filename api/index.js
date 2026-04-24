const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  // 어떤 신호든 들어오면 로그를 남깁니다.
  console.log("📡 [신호 감지] 슬랙에서 데이터가 도착했습니다.");

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // 1. URL 검증 (슬랙에서 'Verified'를 유지하기 위해 필수)
  if (req.body.type === 'url_verification') {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  const event = req.body.event;

  // 2. 봇에게 온 이벤트인지 확인 (조건을 대폭 완화)
  if (event && !event.bot_id) {
    const channel = event.channel;
    const userText = event.text || "";
    
    // [중요] 슬랙 Retries(재시도)는 무시
    if (req.headers['x-slack-retry-num']) return res.status(200).send("ok");

    console.log(`❓ 질문 인식: "${userText}"`);

    try {
      // 질문에서 멘션 태그(@봇이름) 제거
      const cleanedQuestion = userText.replace(/<@.*>/, '').trim();

      // (1) 즉시 첫 반응 보내기 (Vercel 타임아웃 방지용)
      const initialRes = await postToSlack(channel, "🔍 비나우 지식 가이드를 분석 중입니다. 잠시만 기다려주세요...");
      const ts = initialRes.ts;

      // (2) 노션에서 관련 페이지들을 샅샅이 뒤져 지식 추출 (AI 에이전트 핵심 로직)
      const knowledgeContext = await getDeepKnowledge(cleanedQuestion);

      // (3) AI(Gemini)에게 지식과 질문을 주고 답변 생성
      const finalAnswer = await askAIAgent(cleanedQuestion, knowledgeContext);

      // (4) 답변 완료 메시지로 업데이트
      await updateSlackMessage(channel, ts, finalAnswer);
      
      console.log("✅ 답변 전송 완료!");
      return res.status(200).send("ok");

    } catch (error) {
      console.error("❌ 에러 발생:", error);
      return res.status(200).send("error");
    }
  }

  console.log("💤 대상 이벤트가 아니어서 무시됨 (bot_id 확인 등)");
  return res.status(200).send("ignored");
}

// [에이전트 지식 수집 함수]
async function getDeepKnowledge(query) {
  try {
    // 키워드뿐만 아니라 제목/본문 등 연관된 모든 페이지 탐색
    const searchRes = await notion.search({
      query: query,
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 5
    });

    let contextText = "";
    for (const page of searchRes.results) {
      if (page.object === 'page') {
        const title = page.properties?.title?.title?.[0]?.plain_text || 
                      page.properties?.Name?.title?.[0]?.plain_text || "공통 가이드";
        
        // 페이지의 본문 글자들을 긁어옴
        const blocks = await notion.blocks.children.list({ block_id: page.id, page_size: 20 });
        const text = blocks.results
          .map(b => b[b.type]?.rich_text?.map(t => t.plain_text).join("") || "")
          .filter(t => t).join("\n");
        
        contextText += `[문서 제목: ${title}]\n내용: ${text}\n\n`;
      }
    }
    return contextText || "관련된 노션 가이드 내용을 찾지 못했습니다.";
  } catch (e) { return "지식 추출 실패"; }
}

// [AI 에이전트 답변 생성 함수]
async function askAIAgent(question, context) {
  const prompt = `당신은 비나우(BENOW)의 업무지원팀 AI 에이전트입니다.
아래 제공된 [사내 노션 가이드] 정보를 바탕으로 질문에 답하세요.

[사내 노션 가이드]
${context}

[질문]
${question}

[답변 가이드라인]
1. 사내 정보 마스터답게 친절하고 명확하게 답변하세요.
2. 질문자가 '와이파이'나 'wifi'처럼 유사한 단어로 물어도 'WI-FI 가이드'를 참고해 답변하세요.
3. 데이터가 부족하면 모른다고 하고, 사업지원팀 담당자를 찾아달라고 하세요.
4. "주차", "택배", "링크" 등 중요한 키워드에 대한 정보가 있다면 빠짐없이 포함하세요.`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "🤔 가이드를 확인했으나 답변을 구성하기 어렵네요. 노션 가이드를 보강해주세요!";
}

// 슬랙 통신 함수
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
