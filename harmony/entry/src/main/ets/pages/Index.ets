import { common } from '@kit.AbilityKit';
import { KeyboardAvoidMode } from '@kit.ArkUI';
import { AppStore, ServerEntry } from '../state/AppStore';
import { Attachment, ConversationItem, Device, PendingRequest, Project, QuestionAnswer, ThreadSummary,
  WorkspaceSummary } from '../model/Protocol';
import { ServerCard } from '../components/ServerCard';
import { MessageCard } from '../components/MessageCard';
import { RequestCard } from '../components/RequestCard';
import { SettingsControls } from '../components/SettingsControls';
import { BORDER, CARD_BACKGROUND, ERROR, GREEN, INK, MUTED, PAGE_BACKGROUND, PALE_GREEN,
  clientTypeLabel, lastUsedLabel, shortTime, threadStatus, workspaceName } from '../components/Theme';

@Entry
@Component
struct Index {
  @State store: AppStore = new AppStore();
  @State controlsOpen: boolean = false;
  @State revokeId: string = '';
  @State removeServerId: string = '';
  @State expandedTools: string[] = [];
  private timeline: Scroller = new Scroller();
  private followLatest: boolean = true;
  private timelineTimer: number = -1;

  aboutToAppear(): void {
    // Resize scrollable content instead of translating the page beneath the transparent status bar.
    this.getUIContext().setKeyboardAvoidMode(KeyboardAvoidMode.RESIZE);
    this.store.onTimelineChanged = () => {
      if (this.store.screen !== 'chat' || this.store.loading || this.store.olderBusy || !this.followLatest) return;
      if (this.timelineTimer >= 0) return;
      this.timelineTimer = setTimeout(() => {
        this.timelineTimer = -1;
        if (this.store.screen === 'chat' && this.followLatest) this.timeline.scrollEdge(Edge.Bottom);
      }, 80);
    };
    this.store.initialize(this.getUIContext().getHostContext() as common.UIAbilityContext);
  }

  aboutToDisappear(): void {
    clearTimeout(this.timelineTimer);
    this.timelineTimer = -1;
    this.store.onTimelineChanged = () => {};
    this.store.dispose();
  }

  onPageShow(): void {
    this.store.onForeground();
  }

  onBackPress(): boolean {
    if (this.store.screen === 'servers') return false;
    this.store.back();
    return true;
  }

  private overview(): boolean {
    return this.store.mode === 'workspaces' && this.store.workspace === null;
  }

  private visibleWorkspaces(): WorkspaceSummary[] {
    const query = this.store.search.trim().toLocaleLowerCase();
    return this.store.workspaces.filter((workspace: WorkspaceSummary) => !query ||
      workspace.cwd.toLocaleLowerCase().includes(query) ||
      workspaceName(workspace.cwd).toLocaleLowerCase().includes(query));
  }

  private openNew(): void {
    const projects = this.store.boot?.projects || [];
    const selected = projects.find((project: Project) => project.path === this.store.workspace) || projects[0];
    this.store.newProject = selected?.id || '';
    this.store.newSettings = {};
    this.store.screen = 'new';
  }

  private projectOptions(): SelectOption[] {
    return (this.store.boot?.projects || []).map((project: Project): SelectOption => {
      return { value: project.name };
    });
  }

  private projectIndex(): number {
    return (this.store.boot?.projects || []).findIndex((project: Project) => project.id === this.store.newProject);
  }

  private projectPath(): string {
    return this.store.boot?.projects.find((project: Project) => project.id === this.store.newProject)?.path || '';
  }

  private toggleTool(id: string): void {
    this.expandedTools = this.expandedTools.includes(id) ? this.expandedTools.filter((value: string) => value !== id) :
      this.expandedTools.concat([id]);
  }

  private jumpToLatest(): void {
    this.followLatest = true;
    this.timeline.scrollEdge(Edge.Bottom);
  }

  @Builder
  brand() {
    Row({ space: 10 }) {
      Image($r('app.media.app_icon'))
        .width(40)
        .height(40)
        .objectFit(ImageFit.Contain)
        .accessibilityLevel('no')
      Text('Codex 随行').fontSize(20).fontWeight(FontWeight.Medium).fontColor(INK)
    }
  }

  @Builder
  banner(message: string, isError: boolean) {
    Row({ space: 10 }) {
      Text(isError ? this.store.error : this.store.notice)
        .fontSize(13)
        .lineHeight(20)
        .fontColor(isError ? ERROR : GREEN)
        .layoutWeight(1)
      Button('×')
        .padding(0)
        .fontSize(20)
        .width(40)
        .height(40)
        .fontColor(isError ? ERROR : GREEN)
        .backgroundColor(Color.Transparent)
        .accessibilityText('关闭提示')
        .onClick(() => {
          if (isError) this.store.error = '';
          else this.store.notice = '';
        })
    }
    .padding({ left: 16, right: 6, top: 4, bottom: 4 })
    .width('100%')
    .background(isError ? '#F9EDE7' : PALE_GREEN, { ignoresLayoutSafeAreaEdges: [LayoutSafeAreaEdge.TOP] })
  }

  @Builder
  pageHeader(title: string, subtitle: string) {
    Row({ space: 10 }) {
      Button('‹')
        .id('back-to-threads')
        .padding(0)
        .fontSize(32)
        .width(44)
        .height(44)
        .fontColor(GREEN)
        .backgroundColor(PALE_GREEN)
        .accessibilityText('返回上一页')
        .onClick(() => this.store.back())
      Column({ space: 4 }) {
        Text(this.store.screen === 'chat' ? this.store.snapshot?.thread.title || '正在打开会话…' : title)
          .fontSize(18)
          .fontWeight(FontWeight.Medium)
          .fontColor(INK)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        Text(this.store.screen === 'chat' ? `${this.store.contextTitle} · ${this.store.snapshot?.thread.cwd || ''}` : subtitle)
          .fontSize(11)
          .fontColor(MUTED)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      Button('↻')
        .padding(0)
        .fontSize(25)
        .width(44)
        .height(44)
        .fontColor(GREEN)
        .backgroundColor(Color.Transparent)
        .accessibilityText('刷新状态')
        .onClick(() => this.store.refresh())
    }
    .width('100%')
    .padding(16)
  }

  @Builder
  serversPage() {
    Row({ space: 12 }) {
      this.brand()
      Blank()
      Button() {
        Row({ space: 6 }) {
          Image($r('app.media.add_connection')).width(20).height(20).objectFit(ImageFit.Contain)
            .accessibilityLevel('no')
          Text('连接').fontSize(14).fontWeight(FontWeight.Medium).fontColor(CARD_BACKGROUND)
        }.justifyContent(FlexAlign.Center)
      }.id('add-server').width(88).height(46).padding(0).borderRadius(23).backgroundColor(GREEN)
        .accessibilityText('添加连接').onClick(() => this.store.editServer())
    }.width('100%').padding(20)
    Row() {
      Text('你的机器').fontSize(22).fontWeight(FontWeight.Medium).fontColor(INK)
      Blank()
      Button('刷新').height(40).fontSize(13).fontColor(GREEN).backgroundColor(PALE_GREEN)
        .onClick(() => this.store.refreshOverview())
    }.width('100%').padding({ left: 20, right: 20, bottom: 10 })
    List({ space: 20 }) {
      if (this.store.servers.length === 0) {
        ListItem() {
          Column({ space: 14 }) {
            Text('添加一个 Server，接续多台机器上的 Codex 会话。').fontSize(16).lineHeight(25).fontColor(MUTED)
            Button('添加 Server').backgroundColor(GREEN).onClick(() => this.store.editServer())
          }.width('100%').padding(24).backgroundColor(CARD_BACKGROUND).borderRadius(20)
        }
      }
      ForEach(this.store.servers, (entry: ServerEntry) => {
        ListItem() {
          ServerCard({ entry: entry,
            onManage: (id: string) => this.store.editServer(id),
            onChoose: (serverId: string, targetId: string) => { void this.store.chooseTarget(serverId, targetId); } })
        }
      }, (entry: ServerEntry) => entry.profile.id)
      ListItem() {
        Text('机器由各 Server 配置；在前台每 10 秒更新状态。')
          .fontSize(12).fontColor(MUTED).textAlign(TextAlign.Center).width('100%').padding(12)
      }
    }.layoutWeight(1).width('100%').padding({ left: 20, right: 20, bottom: 20 }).scrollBar(BarState.Off)
  }

  @Builder
  pairPage() {
    Scroll() {
      Column({ space: 24 }) {
        Row() {
          this.brand()
          Blank()
          Button('返回').fontSize(13).height(40).fontColor(GREEN).backgroundColor(PALE_GREEN)
            .onClick(() => this.store.showServers())
        }.width('100%')
        Column({ space: 12 }) {
          Text('想法继续，\n不必守在电脑前。')
            .fontSize(34)
            .fontWeight(FontWeight.Medium)
            .lineHeight(43)
            .fontColor(INK)
            .width('100%')
          Text('在手机上接续你的 Codex 会话。\n任务留在电脑，进展随时可见。')
            .fontSize(15)
            .lineHeight(25)
            .fontColor(MUTED)
            .width('100%')
        }
        .alignItems(HorizontalAlign.Start)
        Column({ space: 14 }) {
          Text(this.store.editingServerId ? '管理 Server' : '添加 Server').fontSize(22).fontWeight(FontWeight.Medium).fontColor(INK)
          TextInput({ text: this.store.serverName, placeholder: 'Server 名称，例如：我的 Mac' })
            .id('server-name').height(50).fontSize(14).fontColor(INK).backgroundColor(PAGE_BACKGROUND).maxLength(80)
            .onChange((value: string) => this.store.serverName = value)
          Text('Server 地址').fontSize(12).fontColor(MUTED).width('100%')
          TextInput({ text: this.store.endpoint, placeholder: 'https://你的电脑.ts.net' })
            .id('pair-endpoint')
            .type(InputType.Normal)
            .height(50)
            .fontSize(14)
            .fontColor(INK)
            .backgroundColor(PAGE_BACKGROUND)
            .onChange((value: string) => this.store.endpoint = value)
          Text('设备名称').fontSize(12).fontColor(MUTED).width('100%')
          TextInput({ text: this.store.deviceName, placeholder: '我的 HarmonyOS 手机' })
            .id('pair-device-name')
            .height(50)
            .fontSize(14)
            .fontColor(INK)
            .backgroundColor(PAGE_BACKGROUND)
            .maxLength(80)
            .onChange((value: string) => this.store.deviceName = value)
          Text('一次性配对凭据').fontSize(12).fontColor(MUTED).width('100%')
          TextInput({ text: this.store.pairToken, placeholder: '粘贴电脑生成的凭据或配对链接' })
            .id('pair-credential')
            .type(InputType.Password)
            .height(50)
            .fontSize(14)
            .fontColor(INK)
            .backgroundColor(PAGE_BACKGROUND)
            .onChange((value: string) => this.store.pairToken = value)
          Button(this.store.busy ? '正在连接…' : '配对并保存  ↗')
            .id('pair-submit')
            .width('100%')
            .height(52)
            .fontSize(16)
            .backgroundColor(GREEN)
            .enabled(!this.store.busy && !!this.store.pairToken.trim() &&
              (!!this.store.endpoint.trim() || this.store.pairToken.trim().startsWith('http')))
            .onClick(() => this.store.pair())
          Button('保存名称与地址').width('100%').height(46).fontSize(14).fontColor(GREEN).backgroundColor(PALE_GREEN)
            .enabled(!this.store.busy && !!this.store.endpoint.trim()).onClick(() => this.store.saveServer())
          Text('修改地址后需要重新配对。每个 Server 的登录分别保存。')
            .fontSize(12).lineHeight(20).fontColor(MUTED).width('100%')
          if (this.store.editingServerId) {
            if (this.removeServerId === this.store.editingServerId) {
              Text('仅从手机移除此 Server，电脑任务继续运行。').fontSize(12).fontColor(ERROR)
              Row({ space: 12 }) {
                Button('取消').fontColor(GREEN).backgroundColor(PALE_GREEN).onClick(() => this.removeServerId = '')
                Button('确认移除').backgroundColor(ERROR).enabled(!this.store.busy).onClick(() => {
                  this.store.removeServer(this.store.editingServerId);
                  this.removeServerId = '';
                })
              }
            } else {
              Button('移除 Server').fontSize(13).fontColor(ERROR).backgroundColor('#F9EDE7')
                .onClick(() => this.removeServerId = this.store.editingServerId)
            }
          }
          Text('支持局域网地址或 Tailscale Funnel。\n在电脑项目目录运行 npm run pair 获取凭据。')
            .fontSize(12)
            .lineHeight(20)
            .fontColor(MUTED)
            .width('100%')
        }
        .alignItems(HorizontalAlign.Start)
        .padding(22)
        .width('100%')
        .backgroundColor(CARD_BACKGROUND)
        .borderRadius(24)
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%')
      .padding(24)
    }
    .layoutWeight(1)
    .width('100%')
    .scrollBar(BarState.Off)
  }

  @Builder
  workspaceRow(workspace: WorkspaceSummary) {
    Column({ space: 9 }) {
      Row({ space: 10 }) {
        Text('▱').fontSize(26).fontColor(GREEN)
        Text(workspaceName(workspace.cwd))
          .fontSize(17)
          .fontWeight(FontWeight.Medium)
          .fontColor(INK)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        Text('↗').fontSize(20).fontColor(MUTED)
      }
      Text(workspace.cwd || '没有记录工作路径')
        .fontSize(12)
        .fontColor(MUTED)
        .maxLines(2)
        .wordBreak(WordBreak.BREAK_ALL)
        .width('100%')
      Row({ space: 12 }) {
        Text(`${workspace.threadCount} 个会话`).fontSize(12).fontColor(MUTED)
        if (workspace.activeCount > 0) {
          Text(`● ${workspace.activeCount} 个进行中`).fontSize(12).fontColor(GREEN)
        }
      }
    }
    .alignItems(HorizontalAlign.Start)
    .padding(18)
    .width('100%')
    .backgroundColor(CARD_BACKGROUND)
    .borderRadius(18)
    .onClick(() => this.store.selectWorkspace(workspace.cwd))
    .accessibilityText(`${workspaceName(workspace.cwd)}，${workspace.threadCount} 个会话`)
  }

  @Builder
  threadRow(thread: ThreadSummary) {
    Column({ space: 10 }) {
      Row({ space: 8 }) {
        if (thread.status === 'active') {
          Text('●').fontSize(9).fontColor(GREEN)
        }
        Text(thread.title || '新会话')
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .fontColor(INK)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
      }
      Text(thread.preview || workspaceName(thread.cwd))
        .fontSize(13)
        .lineHeight(20)
        .fontColor(MUTED)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')
      Row({ space: 12 }) {
        Text(workspaceName(thread.cwd))
          .fontSize(11)
          .fontColor(GREEN)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        Text(shortTime(thread.updatedAt)).fontSize(11).fontColor(MUTED)
      }
    }
    .alignItems(HorizontalAlign.Start)
    .padding(18)
    .width('100%')
    .backgroundColor(CARD_BACKGROUND)
    .borderRadius(18)
    .onClick(() => this.store.chooseThread(thread.id))
  }

  @Builder
  threadsPage() {
    Column({ space: 14 }) {
      Row() {
        this.brand()
        Blank()
        Button('＋')
          .id('new-thread')
          .padding(0)
          .fontSize(27)
          .width(46)
          .height(46)
          .backgroundColor(GREEN)
          .enabled(this.store.ready)
          .accessibilityText('新建会话')
          .onClick(() => this.openNew())
      }
      .width('100%')
      Button(`‹  ${this.store.contextTitle}`).fontSize(12).height(36).fontColor(GREEN).backgroundColor(PALE_GREEN)
        .width('100%').onClick(() => this.store.showServers())
      Row({ space: 4 }) {
        Button('全部会话')
          .id('browse-all')
          .layoutWeight(1)
          .height(44)
          .fontSize(14)
          .fontColor(this.store.mode === 'all' ? CARD_BACKGROUND : GREEN)
          .backgroundColor(this.store.mode === 'all' ? GREEN : Color.Transparent)
          .onClick(() => this.store.setMode('all'))
        Button('工作路径')
          .id('browse-workspaces')
          .layoutWeight(1)
          .height(44)
          .fontSize(14)
          .fontColor(this.store.mode === 'workspaces' ? CARD_BACKGROUND : GREEN)
          .backgroundColor(this.store.mode === 'workspaces' ? GREEN : Color.Transparent)
          .onClick(() => this.store.setMode('workspaces'))
      }
      .padding(4)
      .backgroundColor(PALE_GREEN)
      .borderRadius(28)
      if (this.store.mode === 'workspaces' && this.store.workspace !== null) {
        Column({ space: 7 }) {
          Button('‹  全部工作路径')
            .fontSize(13)
            .fontColor(GREEN)
            .backgroundColor(Color.Transparent)
            .height(40)
            .padding({ left: 0, right: 12 })
            .onClick(() => this.store.selectWorkspace(null))
          Text(workspaceName(this.store.workspace || ''))
            .fontSize(20).fontWeight(FontWeight.Medium).fontColor(INK)
          Text(this.store.workspace || '未指定工作路径')
            .fontSize(11).fontColor(MUTED).maxLines(2).wordBreak(WordBreak.BREAK_ALL)
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      }
      TextInput({ text: this.store.search,
        placeholder: this.overview() ? '搜索项目名称或完整路径' : '搜索会话' })
        .id('thread-search')
        .height(48)
        .fontSize(14)
        .fontColor(INK)
        .backgroundColor(CARD_BACKGROUND)
        .onChange((value: string) => this.store.setSearch(value))
      Row() {
        Text(this.overview() ? '按工作路径分组' : '你的会话').fontSize(12).fontColor(MUTED)
        Blank()
        Text(`${this.overview() ? this.visibleWorkspaces().length : this.store.threads.length}`)
          .fontSize(12).fontColor(MUTED)
      }
      .width('100%')
    }
    .padding({ left: 20, right: 20, top: 20, bottom: 12 })
    .width('100%')
    List({ space: 12 }) {
      if (this.overview()) {
        ForEach(this.visibleWorkspaces(), (workspace: WorkspaceSummary) => {
          ListItem() { this.workspaceRow(workspace) }
        }, (workspace: WorkspaceSummary) => JSON.stringify(workspace))
      } else {
        ForEach(this.store.threads, (thread: ThreadSummary) => {
          ListItem() { this.threadRow(thread) }
        }, (thread: ThreadSummary) => JSON.stringify(thread))
      }
      if (this.store.listBusy) {
        ListItem() {
          Row({ space: 10 }) {
            LoadingProgress().width(24).height(24).color(GREEN)
            Text('正在同步会话…').fontSize(13).fontColor(MUTED)
          }.width('100%').justifyContent(FlexAlign.Center).padding(20)
        }
      } else if (this.overview() ? this.visibleWorkspaces().length === 0 : this.store.threads.length === 0) {
        ListItem() {
          Text(this.store.search ? '没有匹配的结果' : '你的会话将在这里显示。')
            .fontSize(14).fontColor(MUTED).width('100%').padding(30).textAlign(TextAlign.Center)
        }
      }
      if (!this.overview() && this.store.nextThreads) {
        ListItem() {
          Button('加载更多会话')
            .width('100%').height(48).fontSize(14).fontColor(GREEN).backgroundColor(PALE_GREEN)
            .enabled(!this.store.listBusy).onClick(() => this.store.loadMore())
        }
      }
    }
    .layoutWeight(1)
    .width('100%')
    .padding({ left: 20, right: 20, bottom: 16 })
    .scrollBar(BarState.Off)
    Row({ space: 10 }) {
      Text('●').fontSize(10).fontColor(this.store.ready ? GREEN : '#BA8E45')
      Column({ space: 3 }) {
        Text(this.store.ready ? '电脑已连接' : '等待连接').fontSize(13).fontColor(INK)
        Text(this.store.boot?.device.name || 'HarmonyOS 手机').fontSize(11).fontColor(MUTED)
      }.alignItems(HorizontalAlign.Start).layoutWeight(1)
      Button('设置')
        .id('open-settings')
        .height(44).fontSize(13).fontColor(GREEN).backgroundColor(PALE_GREEN)
        .onClick(() => {
          this.store.screen = 'settings';
          this.store.loadDevices();
        })
    }
    .width('100%')
    .padding({ left: 24, right: 24, top: 12, bottom: 12 })
    .backgroundColor(CARD_BACKGROUND)
  }

  @Builder
  composer() {
    Column({ space: 10 }) {
      if (this.controlsOpen) {
        SettingsControls({ models: this.store.models, settings: this.store.settings,
          disabled: !this.store.ready || this.store.sending || this.store.snapshot?.thread.status === 'active',
          planAvailable: !!this.store.boot?.capabilities.planMode,
          onModel: (value: string) => this.store.setModel(value),
          onEffort: (value: string) => this.store.setEffort(value),
          onMode: (value: string) => this.store.setSessionMode(value) })
      }
      if (this.store.attachments.length > 0) {
        Scroll() {
          Row({ space: 10 }) {
            ForEach(this.store.attachments, (attachment: Attachment) => {
              Column({ space: 5 }) {
                Image(attachment.localUri || this.store.imageUrl(attachment.url))
                  .width(64).height(64).objectFit(ImageFit.Cover).borderRadius(10)
                Button('移除')
                  .fontSize(11).fontColor(GREEN).backgroundColor(PALE_GREEN).height(28)
                  .enabled(!this.store.sending && !this.store.uploading)
                  .onClick(() => this.store.removeAttachment(attachment.id))
              }
            }, (attachment: Attachment) => attachment.id)
          }
        }.scrollable(ScrollDirection.Horizontal).width('100%')
      }
      TextArea({ text: this.store.draft,
        placeholder: this.store.snapshot?.thread.status === 'active' ? '补充要求，继续当前任务…' : '描述任务，或附上一张截图…' })
        .id('message-draft')
        .height(88)
        .fontSize(15)
        .fontColor(INK)
        .backgroundColor(CARD_BACKGROUND)
        .border({ width: 1, color: BORDER })
        .borderRadius(16)
        .onChange((value: string) => this.store.setDraft(value))
      Row({ space: 8 }) {
        Button(this.store.uploading ? '上传中' : '＋ 图片')
          .id('pick-images')
          .height(44).fontSize(12).fontColor(GREEN).backgroundColor(PALE_GREEN)
          .enabled(this.store.ready && !this.store.uploading && !this.store.sending && !!this.store.boot?.capabilities.images)
          .onClick(() => this.store.pickImages())
        Button(this.controlsOpen ? '收起设置' : (this.store.settings.mode === 'plan' ? 'Plan ▴' : '模型 ▴'))
          .id('toggle-model-controls')
          .height(44).fontSize(12).fontColor(GREEN).backgroundColor(Color.Transparent)
          .onClick(() => this.controlsOpen = !this.controlsOpen)
        Blank()
        Button('↓')
          .padding(0)
          .height(44).width(36).fontSize(20).fontColor(GREEN).backgroundColor(Color.Transparent)
          .accessibilityText('跳到最新消息')
          .onClick(() => this.jumpToLatest())
        if (this.store.snapshot?.thread.status === 'active') {
          Button('■')
            .id('interrupt-turn')
            .padding(0)
            .height(44).width(44).fontSize(17).fontColor(ERROR).backgroundColor('#F9EDE7')
            .enabled(this.store.ready && !this.store.sending)
            .accessibilityText('停止当前任务')
            .onClick(() => this.store.interrupt())
        }
        Button(this.store.sending ? '…' : '↑')
          .id('send-message')
          .padding(0)
          .height(44).width(44).fontSize(24).backgroundColor(GREEN)
          .enabled(this.store.ready && !this.store.sending && !this.store.uploading &&
            this.store.snapshot?.thread.canAcceptDirectInput !== false &&
            (!!this.store.draft.trim() || this.store.attachments.length > 0))
          .accessibilityText(this.store.snapshot?.thread.status === 'active' ? '补充当前任务' : '发送消息')
          .onClick(() => this.store.send())
      }
      .width('100%')
      if (this.store.snapshot?.thread.canAcceptDirectInput === false) {
        Text('此会话暂不接受远程输入，请在电脑处理。')
          .fontSize(11).fontColor(MUTED).width('100%')
      }
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 12, bottom: 12 })
    .backgroundColor(PAGE_BACKGROUND)
  }

  @Builder
  chatPage() {
    this.pageHeader(this.store.snapshot?.thread.title || '正在打开会话…', this.store.snapshot?.thread.cwd || '')
    if (this.store.loading) {
      Column({ space: 12 }) {
        LoadingProgress().width(36).height(36).color(GREEN)
        Text('正在同步会话…').fontSize(14).fontColor(MUTED)
      }.layoutWeight(1).width('100%').justifyContent(FlexAlign.Center)
    } else {
      List({ space: 14, scroller: this.timeline }) {
        if (this.store.snapshot?.nextCursor) {
          ListItem() {
            Button(this.store.olderBusy ? '正在加载…' : '查看更早的消息')
              .height(44).width('100%').fontSize(13).fontColor(GREEN).backgroundColor(PALE_GREEN)
              .enabled(!this.store.olderBusy).onClick(() => this.store.loadOlder())
          }
        }
        ForEach(this.store.snapshot?.items || [], (item: ConversationItem) => {
          ListItem() {
            MessageCard({ item: item, imageSource: (path: string): string => this.store.imageUrl(path),
              expanded: this.expandedTools.includes(item.id), onToggle: (id: string) => this.toggleTool(id) })
          }
        }, (item: ConversationItem) => `${JSON.stringify(item)}:${item.images?.length ? this.store.imageVersion : 0}`)
        if (!this.store.snapshot?.items.length) {
          ListItem() {
            Column({ space: 10 }) {
              Text('一切从你的想法开始').fontSize(22).fontWeight(FontWeight.Medium).fontColor(INK)
              Text('描述任务，或附上一张截图。').fontSize(14).fontColor(MUTED)
            }.width('100%').padding({ top: 80, bottom: 80 })
          }
        }
        if (this.store.snapshot?.warning) {
          ListItem() {
            Text(this.store.snapshot?.warning || '').fontSize(12).lineHeight(20).fontColor(MUTED).padding(12)
          }
        }
        ForEach(this.store.snapshot?.pendingRequests || [], (request: PendingRequest) => {
          ListItem() {
            RequestCard({ request: request, connected: this.store.ready, busy: this.store.busy,
              onAnswer: (id: string, decision: string, answers: QuestionAnswer[]) => {
                this.store.answerRequest(id, decision, answers);
              } })
          }
        }, (request: PendingRequest) => request.id)
        ListItem() {
          Row({ space: 6 }) {
            Text(this.store.snapshot?.thread.status === 'active' ? '●' : '·').fontSize(10).fontColor(GREEN)
            Text(threadStatus(this.store.snapshot?.thread.status || 'idle')).fontSize(12).fontColor(MUTED)
            Blank()
            Button('↓ 最新')
              .fontSize(12).height(36).fontColor(GREEN).backgroundColor(Color.Transparent)
              .onClick(() => this.jumpToLatest())
          }.width('100%').padding({ left: 12, right: 8 })
        }
      }
      .layoutWeight(1)
      .width('100%')
      .padding({ left: 16, right: 16, bottom: 10 })
      .scrollBar(BarState.Off)
      .onTouch((event: TouchEvent) => {
        if (event.type === TouchType.Move) this.followLatest = false;
      })
      .onReachEnd(() => this.followLatest = true)
      .onAppear(() => {
        clearTimeout(this.timelineTimer);
        this.timelineTimer = setTimeout(() => {
          this.timelineTimer = -1;
          if (this.store.screen === 'chat') this.jumpToLatest();
        }, 80);
      })
    }
    this.composer()
  }

  @Builder
  newPage() {
    this.pageHeader('新建会话', '选择工作路径，让想法开始发生。')
    Scroll() {
      Column({ space: 18 }) {
        Text('工作项目').fontSize(13).fontColor(MUTED).width('100%')
        Select(this.projectOptions())
          .selected(this.projectIndex())
          .value(this.store.boot?.projects[this.projectIndex()]?.name || '没有可用项目')
          .font({ size: 16 }).fontColor(INK).backgroundColor(CARD_BACKGROUND)
          .width('100%').height(52).borderRadius(14)
          .onSelect((index: number) => this.store.newProject = this.store.boot?.projects[index]?.id || '')
        Text(this.projectPath())
          .fontSize(12).fontColor(MUTED).wordBreak(WordBreak.BREAK_ALL).width('100%')
        SettingsControls({ models: this.store.models, settings: this.store.newSettings,
          disabled: this.store.busy, planAvailable: !!this.store.boot?.capabilities.planMode,
          onModel: (value: string) => {
            this.store.newSettings = { model: value || undefined, mode: this.store.newSettings.mode };
          },
          onEffort: (value: string) => {
            this.store.newSettings = { model: this.store.newSettings.model, effort: value || undefined,
              mode: this.store.newSettings.mode };
          },
          onMode: (value: string) => {
            this.store.newSettings = { model: this.store.newSettings.model, effort: this.store.newSettings.effort,
              mode: value === 'plan' ? 'plan' : 'default' };
          } })
        Text('会话会同步显示在电脑上的 Codex 中。')
          .fontSize(13).lineHeight(21).fontColor(MUTED).width('100%')
        Button(this.store.busy ? '正在创建…' : '创建会话  ↗')
          .id('create-thread')
          .height(52).width('100%').fontSize(16).backgroundColor(GREEN)
          .enabled(this.store.ready && !this.store.busy && !!this.store.newProject)
          .onClick(() => this.store.createThread(this.store.newProject))
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%').padding(24)
    }.layoutWeight(1).width('100%').scrollBar(BarState.Off)
  }

  @Builder
  deviceRow(device: Device) {
    Column({ space: 9 }) {
      Row({ space: 12 }) {
        Text(device.name)
          .fontSize(16).fontColor(INK).maxLines(2).layoutWeight(1)
        if (device.current) {
          Text('当前客户端').fontSize(11).fontColor(GREEN).padding(7).backgroundColor(PALE_GREEN).borderRadius(8)
        }
      }
      Text(clientTypeLabel(device.clientType)).fontSize(12).fontColor(GREEN)
      Text(device.createdAt ? `首次配对 · ${shortTime(device.createdAt)}` : '首次配对时间未知')
        .fontSize(12).fontColor(MUTED)
      Text(lastUsedLabel(device.lastSeenAt)).fontSize(12).fontColor(MUTED)
      if ((device.authorizationCount || 1) > 1) {
        Text(`${device.authorizationCount} 个入口授权`).fontSize(12).fontColor(MUTED)
      }
      if (this.revokeId === device.id) {
        Text(`撤销「${device.name}」所有入口的访问权限？`).fontSize(13).fontColor(ERROR)
        Row({ space: 10 }) {
          Button('取消').height(42).fontSize(13).fontColor(GREEN).backgroundColor(PALE_GREEN)
            .onClick(() => this.revokeId = '')
          Button('确认撤销').height(42).fontSize(13).backgroundColor(ERROR)
            .enabled(!this.store.busy)
            .onClick(() => {
              this.store.revokeDevice(device.id);
              this.revokeId = '';
            })
        }
      } else {
        Button('撤销访问').height(40).fontSize(12).fontColor(ERROR).backgroundColor('#F9EDE7')
          .onClick(() => this.revokeId = device.id)
      }
    }
    .alignItems(HorizontalAlign.Start).width('100%').padding(18)
    .backgroundColor(CARD_BACKGROUND).borderRadius(18)
  }

  @Builder
  settingsPage() {
    this.pageHeader('连接与客户端', this.store.contextTitle)
    List({ space: 16 }) {
      ListItem() {
        Column({ space: 12 }) {
          Text(this.store.ready ? '● 电脑已连接' : '● 等待连接').fontSize(16).fontColor(GREEN)
          Text(this.store.endpoint).fontSize(13).lineHeight(22).fontColor(INK)
            .wordBreak(WordBreak.BREAK_ALL).copyOption(CopyOptions.LocalDevice)
          Text(this.store.boot?.connection.message || '')
            .fontSize(12).lineHeight(20).fontColor(MUTED)
          Button('重新同步').height(44).fontSize(13).fontColor(GREEN).backgroundColor(PALE_GREEN)
            .onClick(() => this.store.refresh())
        }.alignItems(HorizontalAlign.Start).width('100%').padding(20)
          .backgroundColor(CARD_BACKGROUND).borderRadius(18)
      }
      ListItem() {
        Column({ space: 8 }) {
          Text('已授权客户端').fontSize(14).fontColor(INK)
          Text('同一次安装的 App 在局域网与 Funnel 下显示为一个客户端；浏览器单独显示。')
            .fontSize(12).lineHeight(20).fontColor(MUTED)
          Text('旧版授权会在对应客户端下次访问时识别。无法确认来源的记录会保留，不按名称合并。')
            .fontSize(12).lineHeight(20).fontColor(MUTED)
        }.alignItems(HorizontalAlign.Start).width('100%').padding({ top: 8 })
      }
      ForEach(this.store.devices, (device: Device) => {
        ListItem() { this.deviceRow(device) }
      }, (device: Device) => device.id)
      ListItem() {
        Column({ space: 10 }) {
          Text('退出将撤销此客户端在当前网关的全部入口授权，包括局域网与 Funnel。')
            .fontSize(12).lineHeight(20).fontColor(MUTED)
          Button('退出当前客户端')
            .width('100%').height(50).fontSize(15).fontColor(ERROR).backgroundColor('#F9EDE7')
            .enabled(!this.store.busy).onClick(() => this.store.logout())
        }.alignItems(HorizontalAlign.Start).width('100%')
      }
      ListItem() {
        Text('Codex 随行 · HarmonyOS\n会话和任务在你的电脑上运行。')
          .width('100%').textAlign(TextAlign.Center).fontSize(12).lineHeight(22).fontColor(MUTED).padding(16)
      }
    }.layoutWeight(1).width('100%').padding({ left: 20, right: 20, bottom: 20 }).scrollBar(BarState.Off)
  }

  build() {
    Column() {
      if (this.store.error) {
        this.banner(this.store.error, true)
      }
      if (this.store.notice) {
        this.banner(this.store.notice, false)
      }
      if (!this.store.checked) {
        Column({ space: 16 }) {
          this.brand()
          LoadingProgress().width(36).height(36).color(GREEN)
          Text('正在连接你的工作空间…').fontSize(14).fontColor(MUTED)
        }.width('100%').layoutWeight(1).justifyContent(FlexAlign.Center)
      } else if (this.store.screen === 'pair') {
        this.pairPage()
      } else if (this.store.screen === 'servers' || !this.store.activeServerId) {
        this.serversPage()
      } else if (this.store.screen === 'chat') {
        this.chatPage()
      } else if (this.store.screen === 'new') {
        this.newPage()
      } else if (this.store.screen === 'settings') {
        this.settingsPage()
      } else {
        this.threadsPage()
      }
    }
    .width('100%')
    .height('100%')
    .background(PAGE_BACKGROUND)
  }
}
