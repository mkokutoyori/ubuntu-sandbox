import { CommandRegistry } from './index';
import { EditorState } from '../types';

export const editorCommands: CommandRegistry = {
  nano: (args, state, fs) => {
    const fileName = args.filter(a => !a.startsWith('-'))[0] || 'untitled';
    const filePath = fs.resolvePath(fileName, state.currentPath);
    const node = fs.getNode(filePath);

    let content = '';
    if (node && node.type === 'file') {
      content = node.content || '';
    }

    const editorState: EditorState = {
      type: 'nano',
      filePath,
      content,
      cursorLine: 0,
      cursorCol: 0,
      mode: 'insert',
      modified: false,
    };

    return {
      output: '',
      exitCode: 0,
      editorMode: editorState,
    };
  },

  vi: (args, state, fs) => {
    const fileName = args.filter(a => !a.startsWith('-'))[0] || '';
    
    if (!fileName) {
      const editorState: EditorState = {
        type: 'vi',
        filePath: '',
        content: '',
        cursorLine: 0,
        cursorCol: 0,
        mode: 'normal',
        modified: false,
      };

      return {
        output: '',
        exitCode: 0,
        editorMode: editorState,
      };
    }

    const filePath = fs.resolvePath(fileName, state.currentPath);
    const node = fs.getNode(filePath);

    let content = '';
    let message = '';
    
    if (node) {
      if (node.type === 'directory') {
        return { output: '', error: `"${fileName}" is a directory`, exitCode: 1 };
      }
      content = node.content || '';
    } else {
      message = `"${fileName}" [New File]`;
    }

    const editorState: EditorState = {
      type: 'vi',
      filePath,
      content,
      cursorLine: 0,
      cursorCol: 0,
      mode: 'normal',
      modified: false,
      message,
    };

    return {
      output: '',
      exitCode: 0,
      editorMode: editorState,
    };
  },

  vim: (args, state, fs) => {
    const fileName = args.filter(a => !a.startsWith('-'))[0] || '';
    
    if (!fileName) {
      const editorState: EditorState = {
        type: 'vim',
        filePath: '',
        content: '',
        cursorLine: 0,
        cursorCol: 0,
        mode: 'normal',
        modified: false,
      };

      return {
        output: '',
        exitCode: 0,
        editorMode: editorState,
      };
    }

    const filePath = fs.resolvePath(fileName, state.currentPath);
    const node = fs.getNode(filePath);

    let content = '';
    let message = '';
    
    if (node) {
      if (node.type === 'directory') {
        return { output: '', error: `"${fileName}" is a directory`, exitCode: 1 };
      }
      content = node.content || '';
    } else {
      message = `"${fileName}" [New File]`;
    }

    const editorState: EditorState = {
      type: 'vim',
      filePath,
      content,
      cursorLine: 0,
      cursorCol: 0,
      mode: 'normal',
      modified: false,
      message,
    };

    return {
      output: '',
      exitCode: 0,
      editorMode: editorState,
    };
  },
};
