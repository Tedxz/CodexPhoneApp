import { ModelOption, SessionSettings } from '../model/Protocol';
import { BORDER, CARD_BACKGROUND, GREEN, MUTED } from './Theme';

@Component
export struct SettingsControls {
  @Prop models: ModelOption[] = [];
  @Prop settings: SessionSettings = {};
  @Prop disabled: boolean = false;
  @Prop planAvailable: boolean = false;
  onModel: (value: string) => void = () => {};
  onEffort: (value: string) => void = () => {};
  onMode: (value: string) => void = () => {};

  private modelOptions(): SelectOption[] {
    const result: SelectOption[] = [{ value: '沿用电脑设置' }];
    this.models.forEach((model: ModelOption) => result.push({ value: model.label }));
    return result;
  }

  private modelIndex(): number {
    return this.models.findIndex((model: ModelOption) => model.id === this.settings.model) + 1;
  }

  private modelLabel(): string {
    return this.models.find((model: ModelOption) => model.id === this.settings.model)?.label ||
      this.settings.model || '沿用电脑设置';
  }

  private efforts(): string[] {
    const selected = this.models.find((model: ModelOption) => model.id === this.settings.model) ||
      this.models.find((model: ModelOption) => !!model.isDefault);
    return selected?.efforts || [];
  }

  private effortOptions(): SelectOption[] {
    const result: SelectOption[] = [{ value: '默认强度' }];
    this.efforts().forEach((effort: string) => result.push({ value: effort }));
    return result;
  }

  build() {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        Text('模型').fontSize(11).fontColor(MUTED).width(36)
        Select(this.modelOptions())
          .selected(this.modelIndex())
          .value(this.modelLabel())
          .font({ size: 13 })
          .fontColor(GREEN)
          .backgroundColor(CARD_BACKGROUND)
          .borderRadius(10)
          .height(44)
          .layoutWeight(1)
          .enabled(!this.disabled)
          .onSelect((index: number) => this.onModel(index > 0 ? this.models[index - 1].id : ''))
      }
      Row({ space: 8 }) {
        Text('推理').fontSize(11).fontColor(MUTED).width(36)
        Select(this.effortOptions())
          .selected(this.settings.effort ? this.efforts().indexOf(this.settings.effort) + 1 : 0)
          .value(this.settings.effort || '默认强度')
          .font({ size: 13 })
          .fontColor(GREEN)
          .backgroundColor(CARD_BACKGROUND)
          .borderRadius(10)
          .height(44)
          .layoutWeight(1)
          .enabled(!this.disabled)
          .onSelect((index: number) => this.onEffort(index > 0 ? this.efforts()[index - 1] : ''))
        Select([{ value: '执行' }, { value: 'Plan · 规划' }])
          .selected(this.settings.mode === 'plan' ? 1 : 0)
          .value(this.settings.mode === 'plan' ? 'Plan · 规划' : '执行')
          .font({ size: 13 })
          .fontColor(GREEN)
          .backgroundColor(CARD_BACKGROUND)
          .borderRadius(10)
          .height(44)
          .layoutWeight(1)
          .enabled(!this.disabled && this.planAvailable)
          .onSelect((index: number) => this.onMode(index === 1 ? 'plan' : 'default'))
      }
    }
    .width('100%')
    .padding(10)
    .border({ width: 1, color: BORDER })
    .borderRadius(14)
  }
}
