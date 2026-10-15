import { BORDER, INK, MUTED, PAGE_BACKGROUND } from './Theme';

class TextBlock {
  key: string;
  kind: string;
  text: string;

  constructor(key: string, kind: string, text: string) {
    this.key = key;
    this.kind = kind;
    this.text = text;
  }
}

function blocks(value: string): TextBlock[] {
  const result: TextBlock[] = [];
  const lines = value.split('\n');
  let code = false;
  let pending: string[] = [];
  let kind = 'text';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      if (pending.length > 0) result.push(new TextBlock(`${result.length}`, kind, pending.join('\n')));
      pending = [];
      code = !code;
      kind = code ? 'code' : 'text';
    } else if (code) {
      pending.push(line);
    } else if (/^#{1,6}\s/.test(line)) {
      if (pending.length > 0) result.push(new TextBlock(`${result.length}`, kind, pending.join('\n')));
      pending = [];
      result.push(new TextBlock(`${result.length}`, 'heading', line.replace(/^#{1,6}\s/, '')));
    } else if (line.trim() === '') {
      if (pending.length > 0) result.push(new TextBlock(`${result.length}`, kind, pending.join('\n')));
      pending = [];
      kind = 'text';
    } else {
      pending.push(line.replace(/^[-*]\s/, '• ').replace(/^>\s?/, '│ '));
    }
  }
  if (pending.length > 0) result.push(new TextBlock(`${result.length}`, kind, pending.join('\n')));
  return result;
}

@Component
export struct MarkdownText {
  @Prop text: string = '';

  build() {
    Column({ space: 10 }) {
      ForEach(blocks(this.text || '…'), (block: TextBlock) => {
        if (block.kind === 'code') {
          Scroll() {
            Text(block.text)
              .fontSize(13)
              .lineHeight(20)
              .fontFamily('monospace')
              .fontColor(INK)
              .copyOption(CopyOptions.LocalDevice)
              .padding(12)
          }
          .scrollable(ScrollDirection.Horizontal)
          .width('100%')
          .backgroundColor(PAGE_BACKGROUND)
          .borderRadius(12)
          .border({ width: 1, color: BORDER })
        } else {
          Text(block.text)
            .fontSize(block.kind === 'heading' ? 19 : 16)
            .fontWeight(block.kind === 'heading' ? FontWeight.Medium : FontWeight.Normal)
            .fontColor(block.text.startsWith('│ ') ? MUTED : INK)
            .lineHeight(25)
            .width('100%')
            .copyOption(CopyOptions.LocalDevice)
        }
      }, (block: TextBlock) => `${block.key}:${block.kind}:${block.text}`)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
