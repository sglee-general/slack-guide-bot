const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  if (req.headers['x-slack-retry-num']) return res.status(200).send("ok");
  if (req.body.type === 'url_verification') return res.status(200).json({ challenge: req.body.challenge });

  const event = req.body.event;
  if (event && !event.bot_id && (event.type === 'app_mention' || event.channel_type === 'im')) {
    // 1. 슬랙에게 일단 "나 신호 받았어"라고 200 OK를 던져서 재촉을 막습니다.
    // Vercel은 응답 후에도 프로세스가 잠시 유지되는 특성을 활용합니다.
    res.status(200).send("ok");

    try {
      const channel = event.channel;
      const question = event.text.replace(/<@.*>/, '').trim();
      
      // 2. 진행 상황 알림 (사용자가 기다리게 함)
      const initialMsg = await postToSlack(channel, "🔍 **비나우 업무 가이드 전체를 딥-스캔 중입니다...** (10초 이내 완료)");
      const ts = initialMsg.ts;

      // 3. [핵심] 노션의 모든 페이지와 그 내부 블록들을 샅샅이 뒤집니다.
      const rawData = await deepSearchNotion(question);
      
      // 4. AI(Gemini)에게 지식 주입 및 답변 생성
      const finalAnswer = await askGeminiExpert(question, rawData);

      // 5. 답변 업데이트
      await updateSlackMessage(channel, ts, finalAnswer);

    } catch (error) {
      console.error("Critical Error:", error);
    }
  }
}

// [핵심 로직] 노션 페이지 내부의 모든 블록을 재귀적으로 긁어오는 함수
async function getBlockContent(blockId) {
  let content = "";
  try {
    const blocks = await notion.blocks.children.list({ block_id: blockId });
    for (const block of blocks.results) {
      const type = block.type;
      const value = block[type];
      
      // 텍스트 추출 (문단, 제목, 리스트, 콜아웃 등)
      if (value?.rich_text) {
        content += value.rich_text.map(t => t.plain_text).join("") + "\n";
      }
      // 표(Table) 처리
      if (type === 'table_row') {
        content += value.cells.map(cell => cell.map(t => t.plain_text).join(" ")).join(" | ") + "\n";
      }
      // 하위 페이지가 있으면 또 들어감 (Recursive)
      if (block.has_children) {
        content += await getBlockContent(block.id);
      }
    }
  } catch (e) { /* 에러 무시 */ }
  return content;
}

async function deepSearchNotion(query) {
  const searchRes = await notion.search({
    query: query,
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
    page_size: 5
  });

  let fullKnowledge = "";
  for (const page of searchRes.results) {
    if (page.object === 'page' || page.object === 'database') {
      const pageTitle = page.properties?.title?.title?.[0]?.plain_text || 
                        page.properties?.Name?.title?.[0]?.plain_text || "제목 없음";
      const pageBody = await getBlockContent(page.id);
      fullKnowledge += `\n[문서명: ${pageTitle}]\n${pageBody}\n`;
    }
  }
  return fullKnowledge || "노션에서 텍스트 기반 데이터를 찾지 못했습니다.";
}

async function askGeminiExpert(question, context) {
  const prompt = `당신은 비나우(BENOW) 업무지원팀의 수석 AI 에이전트입니다. 
아래 [사내 노션 지식 가이드]를 기반으로 답변하세요.

[사내 노션 지식 가이드]
${context}

[질문]
${question}

[답변 규칙]
1. 자연어 질문(예: 주차 어떻게 해?)의 의도를 파악하여 노션 내용 중 가장 적합한 정보를 찾으세요.
2. 노션 가이드에 와이파이 비밀번호, 주차 등록 링크, 신청 방법 등이 있다면 상세하게 알려주세요.
3. 데이터가 부족하면 "현재 가이드에는 관련 내용이 없으나, 사업지원팀 담당자에게 문의 바랍니다."라고 하세요.
4. 아주 친절하고 비즈니스 매너 있는 말투를 사용하세요.`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "🤔 가이드를 분석했으나 답변 구성을 실패했습니다. 노션 내용을 보강해 주세요.";
}

// 슬랙 API 함수들
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
