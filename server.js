import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";


dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

const app = express();
app.use(express.json());
const __dirname = dirname(fileURLToPath(import.meta.url));

app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(join(__dirname, "index.html"));
});

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Hardcoded trip dates — timezone-safe, no date math ─────────────────────
const TRIP_DAYS = {
  1: { date: "Monday, July 27, 2026",     dayOfWeek: "Monday"    },
  2: { date: "Tuesday, July 28, 2026",    dayOfWeek: "Tuesday"   },
  3: { date: "Wednesday, July 29, 2026",  dayOfWeek: "Wednesday" },
  4: { date: "Thursday, July 30, 2026",   dayOfWeek: "Thursday"  },
  5: { date: "Friday, July 31, 2026",     dayOfWeek: "Friday"    },
  6: { date: "Saturday, August 1, 2026",  dayOfWeek: "Saturday"  },
  7: { date: "Sunday, August 2, 2026",    dayOfWeek: "Sunday"    },
};

const SYSTEM_PROMPT = `You are a London trip planner for a family with a 17-month-old boy.

TRIP DETAILS (fixed — do not ask the user for these):
- Dates: July 27 – August 2, 2026 (7 days total). Day 1 = July 27, Day 7 = August 2.
- Child: 17-month-old boy who loves to walk but will also use a stroller.
- Home base: Notting Hill, near Westbourne Grove (nearest tube: Royal Oak).
- No Ubers or taxis — no car seat. Use Tube, buses, or walking only.

NAP RHYTHM (fixed):
- Child naps in the stroller on the go — no need to plan around a fixed nap window or return to home base midday.

WEATHER (fixed for this trip — heatwave):
- Expect 85–90°F (30–32°C) every day. This is unusually hot for London and most venues (including many restaurants, cafés, shops, and even museums) do NOT have air conditioning.
- Prioritize: shaded parks, water-play fountains (e.g. Diana Memorial Fountain, Coram's Fields), museums that are confirmed to have A/C, cool indoor spaces (department stores, some cinemas), and cold treats.
- Avoid: unshaded plazas midday, long walks in direct sun between 12–4pm, restaurants known to be stuffy or without A/C at lunch.
- When you recommend an outdoor spot, note the best time of day to visit to avoid peak heat, and mention whether shade/water is available.
- When you recommend an indoor spot, note whether it has air conditioning (search to confirm — do not assume).

TIMEZONE (fixed):
- All times in your response must be in London local time (BST, UTC+1).
- When searching for events, story times, market hours, etc., verify times are in BST.

CHILD'S PREFERRED ACTIVITIES:
- Children's museums, natural history museum, hands-on exhibits
- Playgrounds (especially water features in summer)
- Temporary exhibits suitable for toddlers
- Toy stores (browsing counts!)
- Public libraries (story time, music time — search for scheduled events)
- Parks and green spaces
- Bakeries (toddler-friendly treats, high chairs a plus)

ADULT PREFERENCES:
- New, interesting restaurants and cafés with character
- Farmers markets (check for scheduled ones during the trip dates)
- Outdoor events — concerts, fairs, street festivals
- Anything that feels like a local discovery, not a tourist trap

WHAT TO ACTIVELY SEARCH FOR (use web search):
1. Story time or music time events at London public libraries near the requested neighborhood — only include ones confirmed to run on the day of week stated in the user message
2. Temporary/pop-up exhibits at museums near the neighborhood that are open on that day of week
3. Outdoor concerts, street fairs, or community events happening on the exact date stated in the user message
4. Farmers markets confirmed to operate on that day of week

DAY-OF-WEEK RULE (critical — never override this with your own assumptions):
- The user message will tell you the EXACT date and day of week. Trust it completely — do not recalculate or second-guess it.
- Only suggest places confirmed open on that specific day of week.
- Do not suggest a Saturday farmers market if the day is a Friday. Do not suggest a Tuesday story time if the day is a Monday.
- If unsure whether a place is open that day, flag it in the TIPS field.

OUTPUT FORMAT:
- Generate 6–10 distinct activity ideas for the requested day and neighborhood.
- Do NOT group them into morning/afternoon time slots.
- Each idea should be a self-contained suggestion.
- Use this exact format for each activity:

ACTIVITY: [Name of activity]
TYPE: [one of: Museum | Playground | Library | Park | Restaurant | Cafe | Market | Event | Toy Store | Bakery | Other]
ADDRESS: [Full street address, London, with postcode]
DESCRIPTION: [2–3 sentences. What it is, why it's great for this family, any toddler-specific tips.]
TIPS: [1 sentence — hours (in BST), best time to go, what to bring, or confirmation of opening day. For outdoor spots, note shade/water availability. For indoor spots, note A/C.]

After all activities, output map locations on one line in exactly this format:
MAPLOCATIONS: Place Name 1|Place Name 2|Place Name 3

End with a warm 1-sentence closing note.`;

// In-memory job store. Each job lives for 10 min after completion, then is pruned.
const jobs = new Map();
const JOB_TTL_MS = 10 * 60 * 1000;

function pruneOldJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.completedAt && job.completedAt < cutoff) jobs.delete(id);
  }
}

app.post("/plan", (req, res) => {
  const { day, neighborhood } = req.body;
  const dayNum = parseInt(day);

  if (!dayNum || !neighborhood || !TRIP_DAYS[dayNum]) {
    return res.status(400).json({ error: "Missing or invalid day or neighborhood" });
  }

  pruneOldJobs();

  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: "pending" });

  const { date, dayOfWeek } = TRIP_DAYS[dayNum];
  const userMessage = `TODAY IS ${dayOfWeek.toUpperCase()}, ${date.toUpperCase()}. DO NOT RECALCULATE THE DATE OR DAY OF WEEK — USE EXACTLY WHAT IS STATED HERE.

Please give me activity ideas for Day ${dayNum} of the trip. The day of the week is ${dayOfWeek}. Only suggest activities, events, and places that are open or running on a ${dayOfWeek}. Focus on the ${neighborhood} area of London.

Use web search to find story times, library events, temporary exhibits, outdoor events, and farmers markets — but ONLY include ones confirmed to run on ${dayOfWeek}s.`;

  client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content: userMessage }],
  }).then((response) => {
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    jobs.set(jobId, { status: "done", text, completedAt: Date.now() });
  }).catch((err) => {
    console.error("Job error:", err);
    jobs.set(jobId, { status: "error", error: err.message, completedAt: Date.now() });
  });

  res.json({ jobId });
});

app.get("/plan/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ status: "error", error: "Job not found or expired" });
  }
  res.json(job);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`London Planner running on port ${PORT}`));