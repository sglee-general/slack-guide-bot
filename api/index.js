const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  // 1. 슬랙 재시도 무시
  if (req.headers['x-slack-retry-num']) return res.status(200).send("ok");

  // 2. URL 검증 (Challenge)
  if (req.body.type === 'url_verification') {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  // 3. 홈 탭 열었을 때 (사진처럼 예쁜 화면 만들기)
  if (req.body.event && req.body.event.type === 'app_home_opened') {
    await publishHomeView(req.body.event.user);
    return res.status(200).send("ok");
  }

  // 4. 메시지/멘션 받았을 때 답변 로직
  const event = req.body.event;
  if (event && !event.bot_id && (event.type === 'app_mention' || event.channel_type === 'im')) {
    try {
      const channel = event.channel;
      const question = event.text.replace(/<@.*>/, '').trim();

      // [중요] 답변이 다 완성될 때까지 기다린 후 응답을 보냅니다 (Vercel 조기 종료 방지)
      const initialRes = await postToSlack(channel, "🔍 노션 가이드를 확인하고 있습니다. 잠시만 기다려주세요...");
      const ts = initialRes.ts;

      const context = await searchNotionContent(question);
      const answer = await askGemini(question, context);

      await updateSlackMessage(channel, ts, answer);
      return res.status(200).send("ok"); // 여기서 대답이 끝난 후 종료!
    } catch (error) {
      console.error("에러:", error);
      return res.status(200).send("error");
    }
  }

  return res.status(200).send("ignored");
}

// [홈 탭 꾸미기 함수] - 팀장님이 보내준 사진과 똑같이 구성!
async function publishHomeView(userId) {
  const homeView = {
    type: "home",
    blocks: [
      { type: "header", text: { type: "plain_text", text: "📒 업무 안내봇 사용 방법" } },
      { type: "section", text: { type: "mrkdwn", text: "업무 안내봇은 *비나우 구성원의 업무 가이드*를 슬랙에서 쉽게 확인할 수 있도록 도와주는 앱입니다." } },
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: "*1. 개인적으로 사용할 때*\n상단의 *메시지* 탭을 눌러 직접 질문해 주세요.\n예: `와이파이 비밀번호가 뭐야?` \n예: `주차 등록은 어떻게 해?`" } },
      { type: "section", text: { type: "mrkdwn", text: "*2. 채널에서 사용할 때*\n채널에 봇을 초대한 후 멘션(@)하여 질문하세요.\n예: `@업무 안내봇 wifi`" } },
      { type: "divider" },
      { type: "context", elements: [{ type: "mrkdwn", text: "💡 노션 가이드에 등록된 최신 정보를 바탕으로 답변합니다." }] }
    ]
  };

  await fetch('https://slack.com/api/views.publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ user_id: userId, view: homeView })
  });
}

// [노션 검색 및 AI 로직 - 안전하게 보강]
async function searchNotionContent(query) {
  try {
    const response = await notion.search({ query: query, page_size: 5 });
    let content = "";
    for (const page of response.results) {
      if (page.object === 'page') {
        const blocks = await notion.blocks.children.list({ block_id: page.id });
        const text = blocks.results
          .map(b => b[b.type]?.rich_text?.[0]?.plain_text || "")
          .filter(t => t).join("\n");
        const title = page.properties?.title?.title?.[0]?.plain_text || page.properties?.Name?.title?.[0]?.plain_text || "가이드";
        content += `[${title}]\n${text}\n\n`;
      }
    }
    return content || "노션에서 관련 내용을 찾지 못했습니다.";
  } catch (e) { return "노션 검색 실패"; }
}

async function askGemini(question, context) {
  const prompt = `비나우 업무 가이드 봇입니다. 다음 노션 내용을 참고해 답변하세요.\n\n[노션]:\n${context}\n\n[질문]:\n${question}`;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "답변을 생성할 수 없습니다.";
}

// 슬랙 유틸 함수
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
