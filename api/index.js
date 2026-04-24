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

      const initialRes = await postToSlack(channel, "🔍 노션의 표, 글상자, 리스트를 포함한 모든 텍스트를 정밀 스캔 중입니다...");
      const ts = initialRes.ts;

      // [핵심] 모든 형태의 블록을 다 읽어오도록 대폭 강화된 함수
      const context = await getRichTextFromNotion(question);
      
      console.log("📝 수집된 데이터 길이:", context.length);

      // AI에게 답변 요청
      const answer = await askGeminiExpert(question, context);
      await updateSlackMessage(channel, ts, answer);

    } catch (error) {
      console.error("에러:", error);
    }
  }
}

// [무조건 다 읽어오는 함수]
async function getRichTextFromNotion(query) {
  try {
    const searchRes = await notion.search({ query: query, page_size: 5 });
    let knowledge = "";

    for (const page of searchRes.results) {
      if (page.object === 'page' || page.object === 'database') {
        // 페이지의 본문(Blocks)을 50개까지 넉넉하게 가져옵니다.
        const blocks = await notion.blocks.children.list({ block_id: page.id, page_size: 50 });
        
        const pageText = blocks.results.map(block => {
          const type = block.type;
          const value = block[type];
          
          // 일반 문단, 제목, 리스트, 콜아웃, 할일 목록 등 모든 텍스트 추출
          if (value && value.rich_text) {
            return value.rich_text.map(t => t.plain_text).join("");
          }
          // 표(Table) 내부의 글자도 추출하기 위한 시도
          if (type === 'table_row') {
            return value.cells.map(cell => cell.map(t => t.plain_text).join(" ")).join(" | ");
          }
          return "";
        }).filter(t => t.trim().length > 0).join("\n");

        knowledge += `### [문서 제목: ${page.id}]\n${pageText}\n\n`;
      }
    }
    return knowledge.trim();
  } catch (e) { return ""; }
}

async function askGeminiExpert(question, context) {
  if (!context || context.length < 10) {
    return "⚠️ 노션에서 검색된 페이지는 있으나, 그 안의 **'본문 글자'**를 읽어오지 못했습니다.\n\n**해결 방법:**\n1. 해당 노션 페이지가 이미지/PDF가 아닌 **직접 타이핑한 글자**인지 확인해 주세요.\n2. 봇이 그 상세 페이지에 **[연결 추가]** 되어 있는지 다시 한번 확인해 주세요.";
  }

  const prompt = `비나우 업무 가이드 에이전트입니다. 아래 노션 데이터를 바탕으로 답변하세요.
내용 중에 질문과 관련된 정보(비밀번호, 방법, 링크 등)가 있다면 아주 상세히 알려주세요.

[노션 데이터]:
${context}

[사용자 질문]:
${question}`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "AI가 답변을 요약하는 데 실패했습니다.";
}

// 슬랙 연동 함수 (기존 유지)
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
