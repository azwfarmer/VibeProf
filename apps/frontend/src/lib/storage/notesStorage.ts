import type { Notebook, NotesState } from "../../features/notes/types";
import { createId } from "../ids";

const STORAGE_KEY = "aitutor.local-notes.v1";

const now = () => new Date().toISOString();

export const createBlankPage = (title = "Untitled page") => {
  const timestamp = now();

  return {
    id: createId(),
    title,
    body: "",
    strokes: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
};

export const createBlankNotebook = (title = "Notebook"): Notebook => {
  const timestamp = now();
  const page = createBlankPage("First page");

  return {
    id: createId(),
    title,
    pages: [page],
    createdAt: timestamp,
    updatedAt: timestamp
  };
};

export const createInitialState = (): NotesState => {
  const notebook = createBlankNotebook("Hackathon notes");
  const page = notebook.pages[0];

  return {
    notebooks: [notebook],
    activeNotebookId: notebook.id,
    activePageId: page.id
  };
};

export const loadNotes = (): NotesState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return createInitialState();
    }

    const state = JSON.parse(raw) as NotesState;
    if (!state.notebooks?.length) {
      return createInitialState();
    }

    return {
      ...state,
      notebooks: state.notebooks.map((notebook) => ({
        ...notebook,
        pages: notebook.pages.map((page) => ({
          ...page,
          strokes: page.strokes.map((stroke) => ({ ...stroke, source: stroke.source ?? "user" }))
        }))
      }))
    };
  } catch {
    return createInitialState();
  }
};

export const saveNotes = (state: NotesState) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
};

export const touchNotebook = (notebook: Notebook): Notebook => ({
  ...notebook,
  updatedAt: now()
});

export const timestamp = now;
