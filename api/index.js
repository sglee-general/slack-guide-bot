const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  if (req.headers['x-slack-retry-num']) return res.status(200).send("ok");
  if (req.body.type === 'url_verification') return res.status(200).json({ challenge: req.body.challenge });

  const event = req.body.event;
  if (event && !event.bot_id && (event.type === 'app_mention' || event.channel_type === 'im')) {
    res.status(200).send("ok");

    try {
      const channel = event.channel;
      const question = event.text.replace(/<@.*>/, '').trim();
      
      // 1. 진행 상황 알림
      const initialRes = await postToSlack(channel, "🔍 비나우 업무가이드를 정밀 분석 중입니다...");
      const ts = initialRes.ts;

      // 2. 노션 지식 베이스 구축 (검색 + 최상위 페이지 하위 탐색)
      const context = await buildDeepKnowledge(question);
      console.log("📚 수집된 지식 조각들:", context.substring(0, 200) + "...");

      // 3. AI 에이전트 답변 생성
      const answer = await askAIAgent(question, context);

      // 4. 답변 업데이트
      await updateSlackMessage(channel, ts, answer);
    } catch (error) {
      console.error("❌ 에러 발생:", error);
      await postToSlack(event.channel, "죄송합니다. 지식을 찾는 중 에러가 발생했습니다: " + error.message);
    }
    return;
  }
}

// [핵심] 노션의 지식을 '에이전트' 수준으로 끌어올리는 함수
async function buildDeepKnowledge(query) {
  try {
    // 방법 A: 키워드 검색
    const searchResponse = await notion.search({ query: query, page_size: 5 });
    
    // 방법 B: 최상위 가이드 페이지의 하위 목록 가져오기
    let rootChildren = { results: [] };
    if (process.env.NOTION_PAGE_ID) {
      rootChildren = await notion.blocks.children.list({ block_id: process.env.NOTION_PAGE_ID });
    }

    const combinedResults = [...searchResponse.results, ...rootChildren.results];
    let knowledge = "";

    for (const item of combinedResults) {
      const pageId = item.id;
      if (!pageId) continue;

      try {
        const blocks = await notion.blocks.children.list({ block_id: pageId, page_size: 20 });
        const text = blocks.results
          .map(b => b[b.type]?.rich_text?.map(t => t.plain_text).join("") || "")
          .filter(t => t.length > 5).join("\n");
        
        if (text) knowledge += `--- 가이드 조각 ---\n${text}\n\n`;
      } catch (e) { continue; }
    }

    return knowledge || "노션 가이드에서 관련 내용을 찾지 못했습니다.";
  } catch (err) {
    return "노션 연결 오류";
  }
}

// [핵심] AI에게 '사내 전문가'의 페르소나를 부여
async function askAIAgent(question, context) {
  const prompt = `당신은 비나우(BENOW) 사내 정보를 마스터한 에이전트입니다. 
아래 [사내 가이드 데이터]를 참고하여 질문에 대해 "추측"하지 말고 "사실"에 기반하여 답하세요.

[사내 가이드 데이터]
${context}

[질문]
${question}

[답변 가이드라인]
1. 자연스럽고 친절한 문체로 답변하세요.
2. 만약 데이터에 "와이파이 비밀번호"나 "주차 신청 링크"가 있다면 무조건 포함하세요.
3. 데이터에 내용이 전혀 없다면, "현재 가이드에는 해당 내용이 없습니다. 구체적인 키워드(예: 주차, 연차, wifi)로 다시 물어봐 주시겠어요?"라고 답하세요.
4. 질문자가 "와이파이"라고 묻든 "wifi"라고 묻든 동일하게 처리하세요.`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const data = await res.json();
    
    // API 에러 발생 시 로그 확인용
    if (data.error) {
      console.error("Gemini API 에러:", data.error.message);
      return "🤖 AI 엔진 응답 오류: " + data.error.message;
    }

    return data.candidates?.[0]?.content?.parts?.[0]?.text || "🤔 가이드를 읽어보았으나 명확한 답변을 생성하기 어렵습니다. 노션 가이드 내용을 조금 더 자세히 적어주시면 도움이 됩니다.";
  } catch (e) {
    return "🤖 AI 답변 생성 중 시스템 오류가 발생했습니다.";
  }
}

// 슬랙 연동 함수들
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
