const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  // 어떤 신호든 들어오면 일단 로그부터 찍습니다 (범인 검거용)
  console.log("📍 수신 데이터:", JSON.stringify(req.body));

  // 1. 슬랙 재시도 방지
  if (req.headers['x-slack-retry-num']) {
    console.log("⏩ 재시도 신호 무시");
    return res.status(200).send("ok");
  }

  // 2. URL 검증 (최초 연결용)
  if (req.body.type === 'url_verification') {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  const event = req.body.event;

  // 3. 봇에게 온 신호인지 확인 (멘션 or DM)
  if (event && !event.bot_id && (event.type === 'app_mention' || event.channel_type === 'im')) {
    try {
      const channel = event.channel;
      const question = event.text.replace(/<@.*>/, '').trim();
      console.log("🔍 처리 시작 - 질문:", question);

      // 슬랙 3초 룰을 위해 먼저 메시지를 보냅니다.
      const initialRes = await postToSlack(channel, "🧠 노션 가이드를 분석 중입니다. 잠시만 기다려주세요...");
      const ts = initialRes.ts;

      // [핵심] 노션 전체를 검색 (자연어 대응)
      const context = await getNotionKnowledge(question);
      console.log("📚 노션에서 지식 추출 완료");

      // [핵심] AI가 답변 생성 (담당자 안내봇의 두뇌)
      const answer = await askGeminiExpert(question, context);
      console.log("🤖 AI 답변 생성 완료");

      // 최종 답변으로 업데이트
      await updateSlackMessage(channel, ts, answer);
      
      console.log("✅ 모든 프로세스 완료");
      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error("❌ 에러 발생:", error);
      await postToSlack(event.channel, "죄송합니다. 처리 중 오류가 발생했어요: " + error.message);
      return res.status(200).send("error");
    }
  }

  console.log("💤 조건에 맞지 않는 이벤트이므로 무시함");
  return res.status(200).send("ignored");
}

// 노션에서 내용을 샅샅이 뒤지는 함수 (자연어 검색 강화)
async function getNotionKnowledge(query) {
  try {
    const response = await notion.search({
      query: query,
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 3 // 가장 연관성 높은 3개 페이지
    });

    let context = "";
    for (const page of response.results) {
      if (page.object === 'page') {
        const title = page.properties?.title?.title?.[0]?.plain_text || 
                      page.properties?.Name?.title?.[0]?.plain_text || "가이드";
        
        // 페이지의 첫 10개 블록만 빠르게 읽기
        const blocks = await notion.blocks.children.list({ block_id: page.id, page_size: 10 });
        const text = blocks.results
          .map(b => b[b.type]?.rich_text?.[0]?.plain_text || "")
          .filter(t => t).join(" ");
        
        context += `[가이드: ${title}]\n내용: ${text}\n\n`;
      }
    }
    return context || "노션에서 관련 내용을 찾지 못했습니다.";
  } catch (e) {
    return "노션 지식을 읽어오는 데 실패했습니다.";
  }
}

// AI에게 똑똑하게 답변하라고 시키는 함수
async function askGeminiExpert(question, context) {
  const prompt = `비나우(BENOW) 업무지원팀 전문 AI 비서입니다.
제공된 [노션 가이드]를 기반으로 질문에 답하세요.

[지침]
1. 사용자가 자연어로 물어도 가이드 내용을 찾아 친절하게 설명하세요.
2. 가이드에 근거하여 답변하고, 없는 내용은 모른다고 하세요.
3. wifi 비밀번호, 주차 등록 방법 등 핵심 정보를 정확히 전달하세요.

[노션 가이드]:
${context}

[질문]:
${question}`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "답변을 구성하지 못했습니다.";
}

// 슬랙 통신 유틸리티
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
