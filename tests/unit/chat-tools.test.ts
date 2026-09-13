import { describe, it, expect, vi } from "vitest";
import { executeTool, DELEGATE_TOOL_NAME, TOOL_PARAMETERS, ChatToolHooks, DelegateProvider } from "../../src/main/chat-tools";
import { PROVIDERS } from "../../src/main/providers";

describe("chat-tools", () => {
  describe("DELEGATE_TOOL_NAME", () => {
    const createHooks = () => {
      const delegateToAgent = vi.fn(async (provider: DelegateProvider, reason: string) => {
        return { ok: true as const, cardId: "card-123" };
      });
      const hooks: ChatToolHooks = {
        root: "/tmp/mock-root",
        onToolStart: vi.fn(),
        onToolResult: vi.fn(),
        askWriteConsent: vi.fn(),
        askBashConsent: vi.fn(),
        delegateToAgent,
      };
      return { hooks, delegateToAgent };
    };

    it("1. delegate_to_agent com provider 'cursor' chega em hooks.delegateToAgent como 'cursor' (não vira claude)", async () => {
      const { hooks, delegateToAgent } = createHooks();
      const result = await executeTool(DELEGATE_TOOL_NAME, { provider: "cursor", reason: "test cursor" }, hooks);
      expect(result.ok).toBe(true);
      expect(delegateToAgent).toHaveBeenCalledWith("cursor", "test cursor");
      expect(delegateToAgent).toHaveBeenCalledTimes(1);
    });

    it("2. delegate_to_agent com provider 'opencode' chega em hooks.delegateToAgent como 'opencode'", async () => {
      const { hooks, delegateToAgent } = createHooks();
      const result = await executeTool(DELEGATE_TOOL_NAME, { provider: "opencode", reason: "test opencode" }, hooks);
      expect(result.ok).toBe(true);
      expect(delegateToAgent).toHaveBeenCalledWith("opencode", "test opencode");
      expect(delegateToAgent).toHaveBeenCalledTimes(1);
    });

    it("3. provider 'bash' é RECUSADO (role shell, não é agente delegável)", async () => {
      const { hooks, delegateToAgent } = createHooks();
      const result = await executeTool(DELEGATE_TOOL_NAME, { provider: "bash", reason: "test bash" }, hooks);
      expect(result.ok).toBe(false);
      expect(result.text).toMatch(/inválido ou desconhecido/i);
      expect(delegateToAgent).not.toHaveBeenCalled();
    });

    it("4. provider 'inexistente' é RECUSADO com erro e hooks.delegateToAgent NÃO é chamado", async () => {
      const { hooks, delegateToAgent } = createHooks();
      const result = await executeTool(DELEGATE_TOOL_NAME, { provider: "inexistente", reason: "test invalid" }, hooks);
      expect(result.ok).toBe(false);
      expect(result.text).toMatch(/inválido ou desconhecido/i);
      expect(delegateToAgent).not.toHaveBeenCalled();
    });

    it("5. O enum em TOOL_PARAMETERS contém exatamente os de role agent de providers.ts", () => {
      const expectedAgents = PROVIDERS.filter(p => p.capacity.role === "agent").map(p => p.id);
      const schema = TOOL_PARAMETERS[DELEGATE_TOOL_NAME];
      const enumValues = schema.properties.provider.enum;
      expect(enumValues).toEqual(expectedAgents);
    });
  });
});
