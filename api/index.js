const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  // 1. 슬랙 재시도 신호는 바로 통과 (중복 답변 방지)
  if (req.headers['x-slack-retry-num']) return res.status(200).send("ok");

  // 2. URL 검증
  if (req.body.type === 'url_verification') {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  const event = req.body.event;
  // 3. 봇 본인의 메시지가 아닐 때만 반응
  if (event && !event.bot_id && (event.type === 'app_mention' || event.channel_type === 'im')) {
    
    // 슬랙에게는 일단 '알겠다'고 200 신호를 즉시 보냅니다 (이걸 해야 안 끊깁니다)
    res.status(200).send("ok");

    try {
      const channel = event.channel;
      const question = event.text.replace(/<@.*>/, '').trim();
      console.log("❓ 질문 들어옴:", question);

      // [1단계] 슬랙에 "분석 중" 첫 메시지 보내기
      const initialMsg = await postToSlack(channel, "🧠 노션 가이드를 분석하여 답변을 준비 중입니다. 잠시만 기다려주세요...");
      const ts = initialMsg.ts;

      // [2단계] 노션 전체를 샅샅이 뒤져서 '진짜 지식' 가져오기
      console.log("📚 노션에서 관련 내용을 찾는 중...");
      const context = await getRichNotionContext(question);

      // [3단계] AI(Gemini)에게 노션 지식과 질문을 던져 답변 생성
      console.log("🤖 AI가 답변을 구성 중...");
      const answer = await askGeminiExpert(question, context);

      // [4단계] 생성된 답변으로 슬랙 메시지 업데이트
      await updateSlackMessage(channel, ts, answer);
      console.log("✅ 답변 전송 완료!");

    } catch (error) {
      console.error("❌ 처리 중 에러:", error);
    }
    return;
  }
  return res.status(200).send("no_action");
}

// [핵심] 노션의 제목뿐만 아니라 '본문 내용'까지 긁어오는 함수
async function getRichNotionContext(query) {
  try {
    const searchRes = await notion.search({ query: query, page_size: 5 });
    let knowledge = "";

    for (const page of searchRes.results) {
      if (page.object === 'page') {
        const title = page.properties?.title?.title?.[0]?.plain_text || 
                      page.properties?.Name?.title?.[0]?.plain_text || "공통 가이드";
        
        // 페이지 내부의 텍스트 블록들을 몽땅 가져옵니다
        const blocks = await notion.blocks.children.list({ block_id: page.id });
        const pageText = blocks.results
          .map(b => {
            const blockType = b.type;
            return b[blockType]?.rich_text?.map(t => t.plain_text).join("") || "";
          })
          .filter(t => t).join("\n");

        knowledge += `[페이지: ${title}]\n내용: ${pageText}\n\n`;
      }
    }
    return knowledge || "노션에서 관련 내용을 찾을 수 없습니다.";
  } catch (err) {
    return "노션 데이터를 읽어오는 중 오류가 발생했습니다.";
  }
}

// [핵심] AI에게 지식을 주입하고 자연어로 답변하게 만드는 함수
async function askGeminiExpert(question, context) {
  const prompt = `비나우(BENOW) 업무지원팀 AI 비서입니다.
아래 제공된 [노션 가이드 데이터]를 기반으로 사용자의 질문에 친절하고 상세하게 답변하세요.

[지침]
1. 사용자가 "wifi", "와이파이", "인터넷" 등 유사하게 물어봐도 'WI-FI 가이드'를 찾아 답변하세요.
2. 노션 내용에 주차 등록이나 와이파이 비번이 있다면 그 정보를 정확히 전달하세요.
3. 데이터에 내용이 없으면 "현재 가이드에는 관련 내용이 없습니다. 담당자에게 확인이 필요합니다."라고 하세요.

[노션 가이드 데이터]:
${context}

[사용자 질문]:
${question}`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "🤔 질문은 이해했으나 답변을 구성하지 못했습니다. 노션 가이드를 다시 확인해 주세요.";
  } catch (e) {
    return "🤖 AI 엔진 응답 중 오류가 발생했습니다.";
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
