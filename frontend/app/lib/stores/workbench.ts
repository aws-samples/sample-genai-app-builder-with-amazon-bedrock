import { atom, map, type MapStore, type ReadableAtom, type WritableAtom } from 'nanostores';
import type { EditorDocument, ScrollPosition } from '~/components/editor/codemirror/CodeMirrorEditor';
import { ActionRunner } from '~/lib/runtime/action-runner';
import type { ActionCallbackData, ArtifactCallbackData } from '~/lib/runtime/message-parser';
import { getConnection } from '~/lib/runtime';
import { seedTemplate } from '~/lib/runtime/seed-template';
import type { ITerminal } from '~/types/terminal';
import { createScopedLogger } from '~/utils/logger';
import { EditorStore } from './editor';
import { FilesStore, type FileMap } from './files';
import { PreviewsStore } from './previews';
import { TerminalStore } from './terminal';
import { templateSettingsStore } from './templateSettings';

const logger = createScopedLogger('WorkbenchStore');

export interface ArtifactState {
  id: string;
  title: string;
  closed: boolean;
  runner: ActionRunner;
}

export type ArtifactUpdateState = Pick<ArtifactState, 'title' | 'closed'>;

type Artifacts = MapStore<Record<string, ArtifactState>>;

export type WorkbenchViewType = 'code' | 'preview';

export class WorkbenchStore {
  // A provider, not a captured promise: each store resolves a *healthy*
  // connection per operation and transparently re-boots a dead one. Capturing a
  // single promise at construction — before auth had hydrated — is what left the
  // workbench wedged with red crosses when the first boot lost the race.
  #connect = getConnection;
  #previewsStore = new PreviewsStore(this.#connect);
  #filesStore = new FilesStore(this.#connect);
  #editorStore = new EditorStore(this.#filesStore);
  #terminalStore = new TerminalStore(this.#connect);

  artifacts: Artifacts = import.meta.hot?.data.artifacts ?? map({});

  showWorkbench: WritableAtom<boolean> = import.meta.hot?.data.showWorkbench ?? atom(false);
  currentView: WritableAtom<WorkbenchViewType> = import.meta.hot?.data.currentView ?? atom('code');
  unsavedFiles: WritableAtom<Set<string>> = import.meta.hot?.data.unsavedFiles ?? atom(new Set<string>());
  modifiedFiles = new Set<string>();
  artifactIdList: string[] = [];
  
  // Track if this is the first artifact being added
  #isFirstArtifact = true;

  constructor() {
    if (import.meta.hot) {
      import.meta.hot.data.artifacts = this.artifacts;
      import.meta.hot.data.unsavedFiles = this.unsavedFiles;
      import.meta.hot.data.showWorkbench = this.showWorkbench;
      import.meta.hot.data.currentView = this.currentView;
    }
  }

  get previews() {
    return this.#previewsStore.previews;
  }

  get previewReloadKey() {
    return this.#previewsStore.reloadKey;
  }

  get previewBuildOutput() {
    return this.#previewsStore.buildOutput;
  }

  get files() {
    return this.#filesStore.files;
  }

  get currentDocument(): ReadableAtom<EditorDocument | undefined> {
    return this.#editorStore.currentDocument;
  }

  get selectedFile(): ReadableAtom<string | undefined> {
    return this.#editorStore.selectedFile;
  }

  get firstArtifact(): ArtifactState | undefined {
    return this.#getArtifact(this.artifactIdList[0]);
  }

  get filesCount(): number {
    return this.#filesStore.filesCount;
  }

  get showTerminal() {
    return this.#terminalStore.showTerminal;
  }

  toggleTerminal(value?: boolean) {
    this.#terminalStore.toggleTerminal(value);
  }

  attachTerminal(terminal: ITerminal) {
    this.#terminalStore.attachTerminal(terminal);
  }

  onTerminalResize(cols: number, rows: number) {
    this.#terminalStore.onTerminalResize(cols, rows);
  }

  setDocuments(files: FileMap) {
    // Dirty buffers are named so the rebuild does not overwrite them from disk.
    this.#editorStore.setDocuments(files, this.unsavedFiles.get());

    if (this.#filesStore.filesCount > 0 && this.currentDocument.get() === undefined) {
      // we find the first file and select it
      for (const [filePath, dirent] of Object.entries(files)) {
        if (dirent?.type === 'file') {
          this.setSelectedFile(filePath);
          break;
        }
      }
    }
  }

  setShowWorkbench(show: boolean) {
    this.showWorkbench.set(show);
  }

  setCurrentDocumentContent(newContent: string) {
    const filePath = this.currentDocument.get()?.filePath;

    if (!filePath) {
      return;
    }

    const originalContent = this.#filesStore.getFile(filePath)?.content;
    const unsavedChanges = originalContent !== undefined && originalContent !== newContent;

    this.#editorStore.updateFile(filePath, newContent);

    const currentDocument = this.currentDocument.get();

    if (currentDocument) {
      const previousUnsavedFiles = this.unsavedFiles.get();

      if (unsavedChanges && previousUnsavedFiles.has(currentDocument.filePath)) {
        return;
      }

      const newUnsavedFiles = new Set(previousUnsavedFiles);

      if (unsavedChanges) {
        newUnsavedFiles.add(currentDocument.filePath);
      } else {
        newUnsavedFiles.delete(currentDocument.filePath);
      }

      this.unsavedFiles.set(newUnsavedFiles);
    }
  }

  setCurrentDocumentScrollPosition(position: ScrollPosition) {
    const editorDocument = this.currentDocument.get();

    if (!editorDocument) {
      return;
    }

    const { filePath } = editorDocument;

    this.#editorStore.updateScrollPosition(filePath, position);
  }

  setSelectedFile(filePath: string | undefined) {
    this.#editorStore.setSelectedFile(filePath);
  }

  async saveFile(filePath: string) {
    const documents = this.#editorStore.documents.get();
    const document = documents[filePath];

    if (document === undefined) {
      return;
    }

    await this.#filesStore.saveFile(filePath, document.value);

    const newUnsavedFiles = new Set(this.unsavedFiles.get());
    newUnsavedFiles.delete(filePath);

    this.unsavedFiles.set(newUnsavedFiles);
  }

  /**
   * Persist content that came from somewhere other than the local editor buffer.
   *
   * {@link saveFile} writes whatever the editor store holds for a path, which is
   * only the co-edited content when that file happens to be the one on screen. A
   * collaborator's edit to any other file lives solely in the shared CRDT, so it has
   * to be written from there — see `collab/collab-autosave.ts`.
   *
   * The buffer is updated to match, so the editor and disk do not then disagree, and
   * the path stops counting as unsaved because disk now holds it.
   */
  async saveFileContent(filePath: string, content: string) {
    await this.#filesStore.saveFile(filePath, content);

    this.#editorStore.updateFile(filePath, content);

    const newUnsavedFiles = new Set(this.unsavedFiles.get());
    newUnsavedFiles.delete(filePath);

    this.unsavedFiles.set(newUnsavedFiles);
  }

  /** The container's current content for a path, or undefined if it has no such file. */
  diskContent(filePath: string): string | undefined {
    return this.#filesStore.getFile(filePath)?.content;
  }

  async saveCurrentDocument() {
    const currentDocument = this.currentDocument.get();

    if (currentDocument === undefined) {
      return;
    }

    await this.saveFile(currentDocument.filePath);
  }

  resetCurrentDocument() {
    const currentDocument = this.currentDocument.get();

    if (currentDocument === undefined) {
      return;
    }

    const { filePath } = currentDocument;
    const file = this.#filesStore.getFile(filePath);

    if (!file) {
      return;
    }

    this.setCurrentDocumentContent(file.content);
  }

  async saveAllFiles() {
    for (const filePath of this.unsavedFiles.get()) {
      await this.saveFile(filePath);
    }
  }

  getFileModifcations() {
    return this.#filesStore.getFileModifications();
  }

  resetAllFileModifications() {
    this.#filesStore.resetFileModifications();
  }

  abortAllActions() {
    // TODO: what do we wanna do and how do we wanna recover from this?
  }

  async addArtifact({ messageId, title, id }: ArtifactCallbackData) {
    const artifact = this.#getArtifact(messageId);

    if (artifact) {
      return;
    }

    // Reconcile the preview against the container rather than clearing it.
    //
    // This used to be an unconditional `reset()`, which meant every follow-up
    // prompt blanked a working preview: the container announces a port only on
    // the transition into listening, so a dev server that was already up was
    // never re-announced and the pane sat on "Building your project..." forever
    // in front of an app that was serving fine. Asking which ports are listening
    // still drops a genuinely stale preview from a previous session — the 502
    // this was reaching for — without discarding a live one.
    void this.#previewsStore.onArtifactStart();

    if (!this.artifactIdList.includes(messageId)) {
      this.artifactIdList.push(messageId);
    }

    // Create the artifact with a runner first
    const runner = new ActionRunner(this.#connect);
    runner.onDevServerStart((cmd) => this.#previewsStore.setLastDevServerCommand(cmd));
    const artifactWithRunner = {
      id,
      title,
      closed: false,
      runner,
    };
    
    // Add the artifact to the store
    this.artifacts.setKey(messageId, artifactWithRunner);

    // If this is the first artifact, apply the project template if enabled
    if (this.#isFirstArtifact) {
      this.#isFirstArtifact = false;

      // Check if template is enabled in settings
      const enableTemplate = templateSettingsStore.enableTemplate.get();

      if (enableTemplate) {
        logger.debug('First artifact detected and template is enabled — seeding react-starter-pack');

        // Seed the react-starter-pack tree into the workdir at runtime (bundled
        // with the frontend, written over the fs API — NOT baked into the
        // Docker image). Gate the action runner on it so the agent's own file
        // writes, which edit the same paths (main-page.tsx, package.json, …),
        // land on top of the seeded skeleton rather than racing it.
        const seedPromise = this.#connect()
          .then((conn) => seedTemplate(conn))
          .then((result) => {
            logger.info(`Template seed complete: ${result.written}/${result.total} files`);
          })
          .catch((err) => {
            logger.error('Template seeding failed:', err);
          });

        runner.gateOn(seedPromise);
        this.setShowWorkbench(true);
      } else {
        logger.debug('First artifact detected but template is disabled, skipping template application');
        // Still show the workbench even if template is not applied
        this.setShowWorkbench(true);
      }
    }
  }

  updateArtifact({ messageId }: ArtifactCallbackData, state: Partial<ArtifactUpdateState>) {
    const artifact = this.#getArtifact(messageId);

    if (!artifact) {
      return;
    }

    this.artifacts.setKey(messageId, { ...artifact, ...state });
  }

  async addAction(data: ActionCallbackData) {
    const { messageId } = data;

    const artifact = this.#getArtifact(messageId);

    if (!artifact) {
      logger.error(`Artifact not found for messageId: ${messageId}`);
      return;
    }

    if (!artifact.runner) {
      logger.error(`Runner not found for artifact: ${messageId}`);
      return;
    }

    artifact.runner.addAction(data);
  }

  async runAction(data: ActionCallbackData) {
    const { messageId } = data;

    const artifact = this.#getArtifact(messageId);

    if (!artifact) {
      logger.error(`Artifact not found for messageId: ${messageId}`);
      return;
    }

    if (!artifact.runner) {
      logger.error(`Runner not found for artifact: ${messageId}`);
      return;
    }

    artifact.runner.runAction(data);
  }

  #getArtifact(id: string) {
    const artifacts = this.artifacts.get();
    return artifacts[id];
  }
}

export const workbenchStore = new WorkbenchStore();
