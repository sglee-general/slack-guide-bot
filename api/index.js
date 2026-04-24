const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  // 1. 슬랙의 재시도(Retry) 신호는 무조건 무시 (중복 실행 방지)
  if (req.headers['x-slack-retry-num']) {
    return res.status(200).send("ok");
  }

  // 2. URL 검증
  if (req.body.type === 'url_verification') {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  const event = req.body.event;
  if (event && !event.bot_id && (event.type === 'app_mention' || event.channel_type === 'im')) {
    
    // [중요] Vercel이 중간에 꺼지지 않도록 모든 처리를 await로 기다립니다.
    try {
      const channel = event.channel;
      const question = event.text.replace(/<@.*>/, '').trim();
      console.log("❓ 질문 수신:", question);

      // (1) 먼저 "분석 중"이라고 답장을 보냅니다. (이게 첫 번째 반응)
      const initialRes = await postToSlack(channel, "🧠 비나우 AI 에이전트가 가이드를 분석 중입니다...");
      const ts = initialRes.ts;

      // (2) 노션에서 지식을 추출합니다.
      const context = await getAgentKnowledge(question);
      
      // (3) AI(Gemini)에게 질문과 지식을 전달하여 답변을 생성합니다.
      const answer = await askAIAgent(question, context);

      // (4) 답변이 완성되면 아까 보낸 메시지를 수정합니다.
      await updateSlackMessage(channel, ts, answer);
      
      console.log("✅ 답변 전송 완료");

      // 모든 작업이 끝난 후 비로소 200 OK를 보냅니다.
      return res.status(200).send("ok");

    } catch (error) {
      console.error("❌ 치명적 에러:", error);
      // 에러가 나더라도 종료는 해야 합니다.
      return res.status(200).send("error");
    }
  }

  return res.status(200).send("ignored");
}

// [에이전트급 노션 검색] 제목 + 본문을 지능적으로 수집
async function getAgentKnowledge(query) {
  try {
    const response = await notion.search({
      query: query,
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 5
    });

    let context = "";
    for (const page of response.results) {
      if (page.object === 'page') {
        const title = page.properties?.title?.title?.[0]?.plain_text || 
                      page.properties?.Name?.title?.[0]?.plain_text || "공통 가이드";
        
        // 본문 블록을 30개까지 긁어와서 AI에게 풍부한 정보를 줍니다.
        const blocks = await notion.blocks.children.list({ block_id: page.id, page_size: 30 });
        const text = blocks.results
          .map(b => b[b.type]?.rich_text?.map(t => t.plain_text).join("") || "")
          .filter(t => t.length > 2).join("\n");
        
        context += `### 가이드 주제: ${title}\n상세내용: ${text}\n\n`;
      }
    }
    return context || "노션에 관련 내용이 없습니다.";
  } catch (e) { return "노션 데이터 접근 실패"; }
}

// [AI 에이전트 페르소나] 자연어 이해를 극대화
async function askAIAgent(question, context) {
  const prompt = `당신은 비나우(BENOW) 사내 지식 마스터 AI 에이전트입니다.
아래 제공된 [노션 가이드 데이터]를 바탕으로 직원의 질문에 답하세요.

[사내 가이드 데이터]
${context}

[직원의 질문]
${question}

[답변 원칙]
1. 자연스럽고 명확한 한국어로 답변하세요.
2. 노션 데이터에 기반하여 와이파이 비밀번호, 주차 등록법, 링크 등을 빠짐없이 전달하세요.
3. 데이터에 없는 정보라면 "현재 가이드에는 해당 내용이 없으니 사업지원팀에 문의 부탁드립니다"라고 친절히 안내하세요.
4. "wifi"와 "와이파이"처럼 유사한 용어는 같은 의미로 이해하고 처리하세요.`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "AI가 답변을 구성하지 못했습니다. 노션 가이드를 보강해주세요.";
  } catch (e) { return "AI 답변 생성 중 오류가 발생했습니다."; }
}

// 슬랙 연동 (포스트/업데이트)
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
