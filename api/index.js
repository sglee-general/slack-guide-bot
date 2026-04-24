const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  // 1. 어떤 신호든 들어오면 Vercel 로그에 남깁니다. (범인 추적용)
  console.log("📍 수신된 전체 데이터:", JSON.stringify(req.body));

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // 2. 슬랙 URL 검증용 (최초 연결 시 필요)
  if (req.body.type === 'url_verification') {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  const event = req.body.event;

  // 3. 봇에게 온 이벤트인지 확인 (조건을 아주 느슨하게 풀었습니다)
  if (event && !event.bot_id) {
    const channel = event.channel;
    const text = event.text || "";
    
    // 슬랙에게 "일단 나 신호 받았어!"라고 즉시 대답 (3초 타임아웃 방지)
    res.status(200).send("ok");

    try {
      // 질문에서 봇 이름(@...) 제거
      const question = text.replace(/<@.*>/, '').trim();
      if (!question) return;

      console.log("❓ 질문 인식 성공:", question);

      // [1단계] "생각 중" 메시지 먼저 보내기
      const initialMsg = await postToSlack(channel, "🧠 비나우 AI 에이전트가 가이드를 분석하고 있습니다...");
      const ts = initialMsg.ts;

      // [2단계] 노션 지식 창고 뒤지기 (담당자 안내봇처럼 지능형 검색)
      const context = await getNotionKnowledge(question);

      // [3단계] AI(Gemini)에게 답변 요청
      const answer = await askGeminiAgent(question, context);

      // [4단계] 답변 업데이트
      await updateSlackMessage(channel, ts, answer);
      
    } catch (error) {
      console.error("❌ 처리 중 에러 발생:", error);
    }
    return;
  }

  return res.status(200).send("no_action");
}

// [지능형 검색] 제목뿐만 아니라 본문까지 읽어오는 함수
async function getNotionKnowledge(query) {
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
        
        // 페이지 내부 텍스트 긁어오기 (최대한 많이)
        const blocks = await notion.blocks.children.list({ block_id: page.id, page_size: 30 });
        const text = blocks.results
          .map(b => b[b.type]?.rich_text?.map(t => t.plain_text).join("") || "")
          .filter(t => t.length > 2).join("\n");
        
        context += `### 가이드: ${title}\n내용: ${text}\n\n`;
      }
    }
    return context || "노션에 관련 내용이 아직 등록되지 않았습니다.";
  } catch (e) { return "노션 데이터 접근 실패"; }
}

// [AI 에이전트] 자연어를 이해하고 노션 지식을 조합하는 함수
async function askGeminiAgent(question, context) {
  const prompt = `당신은 비나우(BENOW)의 전문 AI 에이전트입니다.
아래 [노션 지식 베이스]를 읽고 사용자의 질문에 답하세요.

[노션 지식 베이스]
${context}

[질문]
${question}

[답변 가이드]
1. 사내 전문가처럼 친절하고 명확하게 답변하세요.
2. 질문에 '와이파이', '주차', '연차' 등 키워드가 포함되면 지식 베이스에서 해당 정보를 찾아 상세히 설명하세요.
3. 지식 베이스에 없는 내용은 모른다고 답하고, 사내 담당자에게 문의하라고 안내하세요.`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "죄송합니다. 답변을 구성하는 데 어려움이 있습니다.";
  } catch (e) { return "AI 엔진 응답 오류입니다."; }
}

// 슬랙 연동 유틸리티
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
