import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  console.log("🔥 handler 진입");

  if (req.headers['x-slack-retry-num']) {
    return res.status(200).send("ok");
  }

  if (req.body.type === 'url_verification') {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  const event = req.body.event;
  console.log("📩 event:", JSON.stringify(event));

  if (event && !event.bot_id) {

  try {
    const channel = event.channel;
    const question = event.text.replace(/<@.*>/, '').trim();

    console.log("🙋 질문:", question);

    // 🔥 여기서 바로 실행 (async 제거)
    const initialRes = await postToSlack(channel, "🔍 찾는 중...");
    const ts = initialRes.ts;

    const context = await getNotionData(question);
    const answer = await askAIAgent(question, context);

    await updateSlackMessage(channel, ts, answer);

    // 🔥 마지막에 응답
    return res.status(200).send("ok");

  } catch (error) {
    console.error("❌ 에러:", error);
    return res.status(200).send("error");
  }
}

//////////////////////////////
// 🔁 블록 탐색 (깊이 제한)
//////////////////////////////

async function getBlockText(blockId, depth = 0) {
  if (depth > 1) return ""; // 🔥 깊이 제한

  let text = "";

  try {
    const res = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 50
    });

    for (const block of res.results) {
      const type = block.type;
      const richText = block[type]?.rich_text || [];

      const plain = richText.map(t => t.plain_text).join("");

      if (plain) text += plain + "\n";

      if (block.has_children) {
        text += await getBlockText(block.id, depth + 1);
      }
    }

  } catch (e) {
    console.error("❌ 블록 조회 실패:", e);
  }

  return text;
}

//////////////////////////////
// 🏷 제목 추출
//////////////////////////////

function getPageTitle(page) {
  try {
    const properties = page.properties;

    for (const key in properties) {
      if (properties[key].type === "title") {
        return properties[key].title.map(t => t.plain_text).join("");
      }
    }

    return "제목 없음";
  } catch {
    return "제목 없음";
  }
}

//////////////////////////////
// 🤖 AI (Gemini Flash 사용)
//////////////////////////////

async function askAIAgent(question, context) {
  const prompt = `
다음 노션 데이터 기반으로 질문에 답변하세요.

[데이터]
${context}

[질문]
${question}

[규칙]
- 데이터에 있는 내용만 사용
- 없으면 "업무 가이드에서 찾을 수 없습니다."라고 답변
`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      }
    );

    const data = await res.json();

    return data.candidates?.[0]?.content?.parts?.[0]?.text
      || "🤔 AI가 답변을 생성하지 못했습니다.";

  } catch (error) {
    console.error("❌ AI 오류:", error);
    return "AI 응답 중 오류 발생";
  }
}

//////////////////////////////
// 💬 Slack
//////////////////////////////

async function postToSlack(channel, text) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify({ channel, text })
  });

  const data = await res.json();
  console.log("📤 Slack 응답:", data);

  return data;
}

async function updateSlackMessage(channel, ts, text) {
  await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify({ channel, ts, text })
  });
}
