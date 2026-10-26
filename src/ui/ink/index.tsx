import { render } from "ink";
import { createHistorySaver, loadHistory } from "../../inputHistory.js";
import type { ChatUi } from "../runOptions.js";
import { App, InkUiStore, connectSession } from "./App.js";

export interface InkUiOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /** 입력 기록 파일. 첫 줄이 가장 최근 입력이다. */
  historyFile?: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ink 기반 화면. 이벤트를 그리고, 입력과 권한 응답만 Session에 돌려준다. */
export function createInkUi({ stdin, stdout, historyFile }: InkUiOptions): ChatUi {
  const store = new InkUiStore();
  const initialHistory = loadHistory(historyFile);
  const saveHistory =
    historyFile === undefined
      ? undefined
      : createHistorySaver(historyFile, (error) =>
          store.addNotice("dim", `입력 기록을 저장하지 못했습니다: ${errorText(error)}`),
        );

  return {
    prompter: store.prompter,
    asker: store.asker,
    run: (session, options) =>
      new Promise((resolve) => {
        // Ctrl+C는 App이 직접 처리한다(질문 중 거부, 턴 중단, 두 번 눌러 종료).
        const instance = render(
          <App
            store={store}
            session={session}
            commandContext={options.commandContext}
            initialHistory={initialHistory}
            saveHistory={saveHistory}
            {...(options.startupCommand === undefined ? {} : { startupCommand: options.startupCommand })}
          />,
          { stdin, stdout, exitOnCtrlC: false },
        );
        connectSession(store, session, options, () => {
          // 종료 안내(세션 ID)가 화면에 나간 뒤 내린다.
          void instance
            .waitUntilRenderFlush()
            .then(() => {
              instance.unmount();
              return instance.waitUntilExit();
            })
            // 세션은 이미 닫혔으므로 화면 정리 실패로 종료를 막지 않는다.
            .catch(() => undefined)
            .then(() => resolve());
        });
        session.start();
      }),
  };
}
