import { ConversationItem } from '../model/Protocol';
import { MarkdownText } from './MarkdownText';
import { BORDER, CARD_BACKGROUND, ERROR, GREEN, INK, MUTED, PALE_GREEN, itemStatus, toolLabel } from './Theme';

@Component
export struct MessageCard {
  @Prop item: ConversationItem = { id: '', turnId: '', type: '', text: '' };
  @Prop expanded: boolean = false;
  imageSource: (path: string) => string = (path: string): string => '';
  onToggle: (id: string) => void = () => {};

  build() {
    if (this.item.role) {
      Column({ space: 10 }) {
        Text(this.item.role === 'user' ? '你' : 'CODEX')
          .fontSize(11)
          .letterSpacing(1.5)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.item.role === 'user' ? GREEN : MUTED)
        if (this.item.role === 'assistant') {
          MarkdownText({ text: this.item.text })
        } else if (this.item.text) {
          Text(this.item.text)
            .fontSize(16)
            .lineHeight(25)
            .fontColor(INK)
            .width('100%')
            .copyOption(CopyOptions.LocalDevice)
        }
        ForEach(this.item.images || [], (path: string, index: number) => {
          if (this.imageSource(path)) {
            Image(this.imageSource(path))
              .width('100%')
              .height(200)
              .objectFit(ImageFit.Contain)
              .borderRadius(12)
              .accessibilityText(`附图 ${index + 1}`)
          } else {
            Text(`图片附件 ${index + 1}`)
              .fontSize(13)
              .fontColor(MUTED)
              .padding(10)
              .backgroundColor(PALE_GREEN)
              .borderRadius(8)
          }
        }, (path: string, index: number) => `${index}:${path}`)
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%')
      .padding(18)
      .backgroundColor(this.item.role === 'user' ? PALE_GREEN : CARD_BACKGROUND)
      .borderRadius(18)
    } else {
      Column({ space: 12 }) {
        Row({ space: 10 }) {
          Text(this.expanded ? '−' : '+')
            .fontSize(20)
            .fontColor(GREEN)
          Text(toolLabel(this.item.type))
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.item.type === 'error' ? ERROR : INK)
            .layoutWeight(1)
          Text(itemStatus(this.item.status || ''))
            .fontSize(11)
            .fontColor(this.item.status === 'failed' ? ERROR : MUTED)
        }
        .width('100%')
        .constraintSize({ minHeight: 32 })
        .onClick(() => this.onToggle(this.item.id))
        .accessibilityText(`${toolLabel(this.item.type)}，点击${this.expanded ? '收起' : '展开'}`)
        if (this.expanded || this.item.type === 'error' || this.item.type === 'turnStatus') {
          Text(this.item.text || '正在处理…')
            .fontSize(12)
            .fontFamily('monospace')
            .lineHeight(20)
            .fontColor(INK)
            .width('100%')
            .copyOption(CopyOptions.LocalDevice)
        }
      }
      .width('100%')
      .padding(14)
      .backgroundColor(CARD_BACKGROUND)
      .border({ width: 1, color: BORDER })
      .borderRadius(14)
    }
  }
}
