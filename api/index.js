const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  if (req.headers['x-slack-retry-num']) return res.status(200).send("ok");
  if (req.body.type === 'url_verification') return res.status(200).json({ challenge: req.body.challenge });

  const event = req.body.event;
  if (event && !event.bot_id && (event.type === 'app_mention' || event.channel_type === 'im')) {
    const channel = event.channel;
    const question = event.text.replace(/<@.*>/, '').trim();

    try {
      // 1. 첫 반응 (슬랙에 즉시 응답)
      const initialRes = await postToSlack(channel, "🔍 **비나우 업무가이드의 모든 텍스트를 강제로 추출하고 있습니다...**");
      const ts = initialRes.ts;

      // 2. 노션 데이터 추출 (검색 결과 페이지의 모든 블록을 재귀적으로 훑음)
      const searchRes = await notion.search({ query: question, page_size: 3 });
      let knowledgeBase = "";

      for (const page of searchRes.results) {
        if (page.object === 'page') {
          // [강화된 로직] 페이지 내부의 모든 글자를 한 글자도 놓치지 않고 가져옵니다.
          const pageContent = await getAllText(page.id);
          knowledgeBase += `\n[문서: ${page.id}]\n${pageContent}\n`;
        }
      }

      // 3. AI 답변 생성 (Gemini 1.5 Flash)
      const answer = await askGeminiExpert(question, knowledgeBase);

      // 4. 슬랙 답변 업데이트
      await updateSlackMessage(channel, ts, answer);
      
      return res.status(200).send("ok");
    } catch (error) {
      console.error("Critical Error:", error);
      return res.status(200).send("error");
    }
  }
}

// [핵심] 노션의 복잡한 블록 구조를 무시하고 모든 텍스트를 긁어모으는 함수
async function getAllText(blockId) {
  let result = "";
  try {
    const blocks = await notion.blocks.children.list({ block_id: blockId });
    for (const block of blocks.results) {
      const type = block.type;
      // 모든 종류의 텍스트 데이터 추출
      const richText = block[type]?.rich_text || block[type]?.text || [];
      if (richText.length > 0) {
        result += richText.map(t => t.plain_text).join("") + "\n";
      }
      // 표(Table) 데이터 대응
      if (type === 'table_row') {
        result += block.table_row.cells.map(cell => cell.map(t => t.plain_text).join(" ")).join(" | ") + "\n";
      }
      // 하위 블록이 있으면 끝까지 파고들어감
      if (block.has_children) {
        result += await getAllText(block.id);
      }
    }
  } catch (e) {}
  return result;
}

async function askGeminiExpert(question, context) {
  const prompt = `비나우(BENOW) 전문 에이전트입니다. 아래 노션 지식을 '전수 조사'하여 질문에 답하세요.
정보가 조금이라도 포함되어 있다면(예: 와이파이 비밀번호, 공유폴더 경로 등) 절대 놓치지 말고 상세히 답변하세요.

[수집된 노션 지식]:
${context || "지식을 수집하지 못했습니다."}

[사용자 질문]:
${question}`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "🤔 가이드를 읽었으나 답변을 구성하지 못했습니다. 노션 본문의 텍스트를 다시 확인해 주세요.";
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
