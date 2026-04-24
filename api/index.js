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

      // 1. 먼저 "생각 중" 메시지 보내기
      const initialRes = await postToSlack(channel, "🧠 노션 가이드를 분석해서 답변을 준비 중입니다. 약 5~10초 소요됩니다...");
      const ts = initialRes.ts;

      // 2. [핵심] 노션 전체 페이지 목록과 내용을 가져옴
      const context = await getFullNotionKnowledge(question);

      // 3. AI(Gemini)에게 "자연어 질문"과 "노션 지식"을 한꺼번에 전달
      const answer = await askGeminiExpert(question, context);

      // 4. 답변 업데이트
      await updateSlackMessage(channel, ts, answer);
    } catch (error) {
      console.error("에러 발생:", error);
      await postToSlack(event.channel, "❌ 답변 도중 오류가 발생했어요. 다시 한번 말씀해 주세요!");
    }
    return;
  }
}

// [개조된 노션 지식 추출 함수]
async function getFullNotionKnowledge(query) {
  try {
    // 단순 검색이 아니라, 최근 업데이트된 페이지 5개를 싹 긁어옵니다.
    const response = await notion.search({
      query: query,
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 5
    });

    if (!response.results.length) return "가이드에 관련 내용이 없습니다.";

    let knowledgeBase = "";
    for (const page of response.results) {
      if (page.object === 'page') {
        const title = page.properties?.title?.title?.[0]?.plain_text || 
                      page.properties?.Name?.title?.[0]?.plain_text || "알 수 없는 페이지";
        
        // 해당 페이지의 모든 텍스트 블록을 가져옴
        const blocks = await notion.blocks.children.list({ block_id: page.id });
        const pageText = blocks.results
          .map(b => b[b.type]?.rich_text?.[0]?.plain_text || "")
          .filter(t => t).join(" ");

        knowledgeBase += `### [가이드 제목: ${title}]\n내용: ${pageText}\n\n`;
      }
    }
    return knowledgeBase;
  } catch (e) {
    return "노션 지식을 가져오는 데 실패했습니다.";
  }
}

// [개조된 AI 프롬프트 - 자연어 처리 강화]
async function askGeminiExpert(question, context) {
  const prompt = `당신은 비나우(BENOW)의 지식 기반 전문 비서입니다. 
제공된 [노션 업무 가이드 데이터]를 기반으로 사용자의 질문에 답하세요.

[지시 사항]
1. 사용자가 "wifi", "와이파이", "인터넷" 등 유사한 단어로 물어도 'WI-FI 가이드' 페이지를 참고해 답변하는 유연함을 발휘하세요.
2. 질문에 대한 직접적인 답뿐만 아니라, 가이드에 적힌 주의사항이나 링크가 있다면 함께 친절하게 설명하세요.
3. 만약 데이터에 답이 절대 없다면 "죄송합니다. 해당 내용은 현재 업무 가이드에 등록되어 있지 않습니다."라고 답하세요.

[노션 업무 가이드 데이터]:
${context}

[사용자 질문]:
${question}`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "🤔 질문을 이해했지만 답변을 구성하기 어렵네요. 다시 한번 질문해 주시겠어요?";
  } catch (e) {
    return "🤖 AI 엔진에 잠시 오류가 발생했습니다.";
  }
}

// 슬랙 유틸 함수 (생략 없이 유지)
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
