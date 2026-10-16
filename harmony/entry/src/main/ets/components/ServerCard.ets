import { ServerEntry, TargetEntry } from '../state/AppStore';
import { CARD_BACKGROUND, ERROR, GREEN, INK, MUTED, PALE_GREEN } from './Theme';

// Stable ForEach keys retain these components. ObjectLink subscribes each row
// to its own model so a late poll result updates it without rebuilding a list.
@Component
struct TargetCard {
  @ObjectLink server: ServerEntry;
  @ObjectLink target: TargetEntry;
  onChoose: (serverId: string, targetId: string) => void = () => {};

  build() {
    Row({ space: 12 }) {
      Text(this.target.kind === 'ssh' ? '↗' : '▣').fontSize(23).fontColor(GREEN)
      Column({ space: 6 }) {
        Text(this.target.name).fontSize(17).fontWeight(FontWeight.Medium).fontColor(INK)
        Text(`${this.target.kind === 'ssh' ? 'SSH 远程' : '本机'} · ${this.server.error ? '状态未更新' : this.target.connection.connected ? 'Codex 已连接' : this.target.connection.message}`)
          .fontSize(12).fontColor(this.server.error || !this.target.connection.connected ? MUTED : GREEN).maxLines(3)
      }.layoutWeight(1).alignItems(HorizontalAlign.Start)
      Text('›').fontSize(25).fontColor(MUTED)
    }.padding(16).width('100%').backgroundColor(CARD_BACKGROUND).borderRadius(16)
      .onClick(() => this.onChoose(this.server.profile.id, this.target.id))
      .accessibilityText(`${this.server.profile.name}，${this.target.name}，${this.target.connection.message}`)
  }
}

@Component
export struct ServerCard {
  @ObjectLink entry: ServerEntry;
  onManage: (id: string) => void = () => {};
  onChoose: (serverId: string, targetId: string) => void = () => {};

  build() {
    Column({ space: 10 }) {
      Row({ space: 10 }) {
        Column({ space: 4 }) {
          Text(this.entry.profile.name).fontSize(19).fontWeight(FontWeight.Medium).fontColor(INK)
          Text(this.entry.profile.origin).fontSize(11).fontColor(MUTED).maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }.layoutWeight(1).alignItems(HorizontalAlign.Start)
        Button('管理').height(38).fontSize(12).fontColor(GREEN).backgroundColor(PALE_GREEN)
          .onClick(() => this.onManage(this.entry.profile.id))
      }.width('100%')
      if (this.entry.error) {
        Text(this.entry.error).fontSize(12).fontColor(ERROR).width('100%')
        if (!this.entry.profile.cookie) {
          Button('重新配对').height(42).fontSize(13).backgroundColor(GREEN)
            .onClick(() => this.onManage(this.entry.profile.id))
        }
      } else if (this.entry.loading && this.entry.targets.length === 0) {
        Text('正在获取机器…').fontSize(13).fontColor(MUTED)
      } else if (this.entry.targets.length === 0) {
        Text('此 Server 尚未配置机器').fontSize(13).fontColor(MUTED)
      }
      ForEach(this.entry.targets, (target: TargetEntry) => {
        TargetCard({ server: this.entry, target: target, onChoose: this.onChoose })
      }, (target: TargetEntry) => target.id)
    }.width('100%').alignItems(HorizontalAlign.Start)
  }
}
