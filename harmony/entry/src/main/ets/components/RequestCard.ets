import { InputQuestion, PendingRequest, QuestionAnswer, QuestionOption } from '../model/Protocol';
import { BORDER, CARD_BACKGROUND, GREEN, INK, MUTED, PALE_GREEN } from './Theme';

@Component
export struct RequestCard {
  @Prop request: PendingRequest = { id: '', threadId: '', kind: 'unsupported', title: '', detail: '' };
  @Prop connected: boolean = false;
  @Prop busy: boolean = false;
  @State values: string[] = [];
  onAnswer: (id: string, decision: string, answers: QuestionAnswer[]) => void = () => {};

  private updateValue(index: number, value: string): void {
    const next = this.values.slice();
    next[index] = value;
    this.values = next;
  }

  private canAnswer(): boolean {
    const questions = this.request.questions || [];
    return questions.length > 0 && questions.every((question: InputQuestion, index: number) =>
      !!this.values[index]?.trim());
  }

  private submitAnswers(): void {
    const questions = this.request.questions || [];
    const answers: QuestionAnswer[] = questions.map((question: InputQuestion, index: number): QuestionAnswer => {
      return { id: question.id, answers: [this.values[index].trim()] };
    });
    this.onAnswer(this.request.id, '', answers);
  }

  private decisionLabel(decision: string): string {
    if (decision === 'accept') return '允许本次';
    if (decision === 'decline') return '拒绝';
    return '取消任务';
  }

  @Builder
  questionField(question: InputQuestion, index: number) {
    Column({ space: 10 }) {
      Text(question.question)
        .fontSize(15)
        .lineHeight(23)
        .fontColor(INK)
        .width('100%')
      ForEach(question.options || [], (option: QuestionOption) => {
        Column({ space: 4 }) {
          Text(option.label)
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .fontColor(INK)
            .width('100%')
          if (option.description) {
            Text(option.description)
              .fontSize(12)
              .lineHeight(19)
              .fontColor(MUTED)
              .width('100%')
          }
        }
        .alignItems(HorizontalAlign.Start)
        .padding(12)
        .width('100%')
        .backgroundColor(this.values[index] === option.label ? PALE_GREEN : CARD_BACKGROUND)
        .border({ width: 1, color: this.values[index] === option.label ? GREEN : BORDER })
        .borderRadius(10)
        .enabled(this.connected && !this.busy)
        .onClick(() => this.updateValue(index, option.label))
      })
      TextInput({ text: this.values[index] || '', placeholder: '也可以输入你的回答' })
        .type(question.isSecret ? InputType.Password : InputType.Normal)
        .height(48)
        .fontSize(14)
        .fontColor(INK)
        .backgroundColor('#F6F7F2')
        .enabled(this.connected && !this.busy)
        .onChange((value: string) => this.updateValue(index, value))
    }
    .width('100%')
  }

  build() {
    Column({ space: 14 }) {
      Text('需要你的确认')
        .fontSize(11)
        .fontWeight(FontWeight.Medium)
        .fontColor(GREEN)
      Text(this.request.title)
        .fontSize(19)
        .fontWeight(FontWeight.Medium)
        .fontColor(INK)
      if (this.request.detail) {
        Text(this.request.detail)
          .fontSize(12)
          .fontFamily('monospace')
          .lineHeight(19)
          .fontColor(MUTED)
          .copyOption(CopyOptions.LocalDevice)
      }
      ForEach(this.request.questions || [], (question: InputQuestion, index: number) => {
        this.questionField(question, index)
      }, (question: InputQuestion) => question.id)
      if (this.request.kind === 'userInput') {
        Button(this.busy ? '正在发送…' : '提交回答')
          .height(48)
          .width('100%')
          .fontSize(15)
          .backgroundColor(GREEN)
          .enabled(this.connected && !this.busy && this.canAnswer())
          .onClick(() => this.submitAnswers())
      } else {
        ForEach(this.request.decisions || [], (decision: string) => {
          Button(this.decisionLabel(decision))
            .height(46)
            .width('100%')
            .fontSize(14)
            .fontColor(decision === 'accept' ? CARD_BACKGROUND : GREEN)
            .backgroundColor(decision === 'accept' ? GREEN : PALE_GREEN)
            .enabled(this.connected && !this.busy)
            .onClick(() => this.onAnswer(this.request.id, decision, []))
        }, (decision: string) => decision)
        if (!this.request.decisions?.length) {
          Text('请在电脑上的 Codex 中处理此请求。')
            .fontSize(13)
            .fontColor(MUTED)
        }
      }
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .padding(18)
    .backgroundColor(CARD_BACKGROUND)
    .border({ width: 1, color: '#A6BCA5' })
    .borderRadius(18)
  }
}
