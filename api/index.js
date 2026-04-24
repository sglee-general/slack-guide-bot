const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  if (req.headers['x-slack-retry-num']) return res.status(200).send("ok");
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  if (req.body.type === 'url_verification') return res.status(200).json({ challenge: req.body.challenge });

  const event = req.body.event;
  if (event && !event.bot_id && (event.type === 'app_mention' || event.channel_type === 'im')) {
    res.status(200).send("ok");

    try {
      const channel = event.channel;
      const question = event.text.replace(/<@.*>/, '').trim();

      const initialRes = await postToSlack(channel, "🔍 노션 가이드를 샅샅이 뒤지고 있습니다. 잠시만요...");
      const ts = initialRes.ts;

      // [개선] 검색 결과가 없을 때를 대비해 검색어를 더 단순화해서 시도
      const context = await searchNotionContent(question);

      const answer = await askGemini(question, context);
      await updateSlackMessage(channel, ts, answer);

    } catch (error) {
      console.error("최종 에러:", error);
    }
    return;
  }
}

async function searchNotionContent(query) {
  try {
    // 1. 노션 검색 실행
    const response = await notion.search({
      query: query,
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 5
    });
    
    if (!response.results || response.results.length === 0) return "노션에서 관련 문서를 찾지 못했습니다.";

    let fullContent = "";
    for (const page of response.results) {
      // 페이지 혹은 데이터베이스면 내용을 가져옵니다.
      if (page.object === 'page') {
        const blocks = await notion.blocks.children.list({ block_id: page.id });
        
        // 제목 추출 안전하게
        const title = page.properties?.title?.title?.[0]?.plain_text || 
                      page.properties?.Name?.title?.[0]?.plain_text || "제목 없음";
        
        // [개선] 문단뿐만 아니라 리스트, 제목, 콜아웃 등 모든 텍스트 추출
        const text = blocks.results
          .map(b => {
            const type = b.type;
            const content = b[type]?.rich_text?.map(t => t.plain_text).join("") || "";
            return content;
          })
          .filter(t => t.length > 0)
          .join("\n");

        fullContent += `### 가이드 제목: ${title}\n${text}\n\n`;
      }
    }
    return fullContent;
  } catch (e) {
    console.error("노션 검색 중 에러:", e);
    return "노션 연결 중 오류가 발생했습니다.";
  }
}

async function askGemini(question, context) {
  try {
    const prompt = `당신은 비나우(BENOW) 업무지원팀의 AI 에이전트입니다.
제공된 [노션 업무 가이드]를 바탕으로 사용자의 질문에 답하세요.

[지침]
1. 가이드 내용에 기반하여 정확하고 친절하게 답변하세요.
2. 만약 가이드에 "wifi" 관련 내용이 있고 질문이 "와이파이"라면 같은 것으로 이해하고 답변하세요.
3. 가이드에 없는 내용이라면 추측하지 말고 "현재 가이드에는 관련 내용이 없습니다. 담당자에게 확인이 필요합니다."라고 하세요.

[노션 업무 가이드]:
${context}

[사용자 질문]:
${question}`;
    
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const data = await res.json();
    
    // 구조 분해 할당으로 안전하게 데이터 추출
    const answerText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return answerText || "AI가 답변을 생성하는 데 실패했습니다. 다시 시도해 주세요.";
  } catch (e) {
    return "죄송합니다. AI 답변 도중 오류가 발생했습니다.";
  }
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
