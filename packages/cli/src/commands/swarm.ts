import { Command } from "commander";

// `squad swarm <prompt>`: preview of the lane plan for a prompt. It launches nothing yet.

export interface SwarmLane {
  seat: "backend" | "frontend" | "qa";
  branch: string;
  brief: string;
}

export interface SwarmPlan {
  prompt: string;
  mission: string;
  lanes: SwarmLane[];
}

export function missionSlug(prompt: string): string {
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "");
  return slug || "swarm";
}

export function planSwarm(prompt: string): SwarmPlan {
  const text = prompt.trim();
  if (!text) throw new Error('squad swarm needs a prompt, for example: squad swarm "Build Auth API"');
  const mission = missionSlug(text);
  const lane = (seat: SwarmLane["seat"], brief: string): SwarmLane => ({ seat, branch: `squad/${mission}/${seat}`, brief });
  return {
    prompt: text,
    mission,
    lanes: [
      lane("backend", `Build the server side of: ${text}`),
      lane("frontend", `Build the client side of: ${text}`),
      lane("qa", `Write and run tests for: ${text}, after backend and frontend land`),
    ],
  };
}

export function swarmCommand(): Command {
  return new Command("swarm")
    .description("Preview the parallel agent squad for a prompt (plan only; no agents are launched yet)")
    .argument("<prompt>", "What the squad should build")
    .action((prompt: string) => {
      let plan: SwarmPlan;
      try {
        plan = planSwarm(prompt);
      } catch (err) {
        console.error(`refused: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Swarm plan: ${plan.prompt}`);
      console.log(`Mission:    ${plan.mission}`);
      for (const lane of plan.lanes) {
        console.log(`  ${lane.seat.padEnd(8)} ${lane.branch}`);
        console.log(`           ${lane.brief}`);
      }
      console.log("");
      console.log("Preview only. The lanes are a fixed backend / frontend / qa template, not an agent's split of your prompt.");
      console.log("Worktree sandboxes, agent launch and the test gate are not implemented in this version.");
    });
}
