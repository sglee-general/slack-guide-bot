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
      const initialRes = await postToSlack(channel, "🔍 **노션 지식 2,206자를 정밀 분석하여 답변을 구성 중입니다...**");
      const ts = initialRes.ts;

      // [핵심] 검색된 페이지 리스트와 내용을 정돈해서 가져옴
      const { knowledge, sourcePages } = await getRefinedKnowledge(question);
      
      // Vercel 로그에서 팀장님이 직접 내용을 확인하실 수 있게 기록
      console.log("📄 AI에게 전달되는 지식 원문:", knowledge);

      const answer = await askGeminiExpert(question, knowledge, sourcePages);
      await updateSlackMessage(channel, ts, answer);
      
      console.log("✅ 답변 전송 완료!");
    } catch (error) {
      console.error("❌ 에러:", error);
    }
  }
}

async function getRefinedKnowledge(query) {
  const searchRes = await notion.search({ query: query, page_size: 5 });
  let knowledge = "";
  let sourcePages = [];

  for (const page of searchRes.results) {
    if (page.object === 'page') {
      const title = page.properties?.title?.title?.[0]?.plain_text || 
                    page.properties?.Name?.title?.[0]?.plain_text || "제목 없음";
      sourcePages.push(title);
      
      const body = await fetchAllBlocks(page.id);
      // AI가 구분하기 쉽게 구분선을 넣어줍니다.
      knowledge += `\n--- [가이드 페이지: ${title}] ---\n${body}\n`;
    }
  }
  return { knowledge, sourcePages };
}

async function fetchAllBlocks(blockId) {
  let text = "";
  try {
    const blocks = await notion.blocks.children.list({ block_id: blockId });
    for (const block of blocks.results) {
      const type = block.type;
      const richText = block[type]?.rich_text || [];
      if (richText.length > 0) {
        text += richText.map(t => t.plain_text).join("") + " ";
      }
      if (type === 'table_row') {
        text += block.table_row.cells.map(cell => cell.map(t => t.plain_text).join(" ")).join(" | ") + "\n";
      }
      if (block.has_children) {
        text += await fetchAllBlocks(block.id);
      }
    }
  } catch (e) {}
  return text;
}

async function askGeminiExpert(question, context, sources) {
  const prompt = `당신은 비나우(BENOW)의 전문 AI 에이전트입니다.
제공된 [사내 지식 데이터]에서 사용자의 질문에 대한 답을 찾아 친절하게 설명하세요.

[사내 지식 데이터]
${context}

[질문]
${question}

[답변 원칙]
1. 데이터 속에 '비밀번호', '방법', '주소' 등 구체적인 정보가 있다면 누락 없이 답변하세요.
2. 데이터의 양이 많으므로 꼼꼼히 읽고 질문과 관련된 부분을 요약하세요.
3. 만약 데이터에 답이 없다면, 아래 형식으로 대답하세요:
"찾으시는 내용을 가이드에서 발견하지 못했습니다. (참고한 페이지: ${sources.join(", ")})\n혹시 내용이 이미지(사진) 속에 있거나 다른 페이지에 있는지 확인해 주세요."`;

  // 모델을 최신 1.5-flash로 변경 (더 똑똑하고 빠릅니다)
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "AI 답변 생성 오류가 발생했습니다.";
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
