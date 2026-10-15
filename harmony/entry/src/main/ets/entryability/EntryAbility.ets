import { UIAbility, ConfigurationConstant } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { INK } from '../components/Theme';

export default class EntryAbility extends UIAbility {
  private mainWindow: window.Window | undefined = undefined;

  onCreate(): void {
    try {
      this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT);
    } catch {
      hilog.warn(0, 'CodexPhone', 'Unable to set preferred color mode.');
    }
  }
  onWindowStageCreate(stage: window.WindowStage): void {
    try {
      stage.loadContent('pages/Index', (error) => {
        if (error.code) {
          hilog.error(0, 'CodexPhone', 'Unable to load app page: %{public}d', error.code);
          return;
        }
        try {
          this.mainWindow = stage.getMainWindowSync();
          this.applyWindowAppearance();
        } catch {
          hilog.warn(0, 'CodexPhone', 'Unable to get the app window.');
        }
      });
    } catch {
      hilog.error(0, 'CodexPhone', 'Unable to create app page.');
    }
  }
  private async applyWindowAppearance(): Promise<void> {
    const mainWindow = this.mainWindow;
    if (!mainWindow) return;
    try {
      // Index extends only its background into the safe area; controls keep their normal insets.
      await mainWindow.setWindowSystemBarProperties({
        statusBarColor: '#00000000',
        statusBarContentColor: INK,
        enableStatusBarAnimation: false,
        navigationBarColor: '#00000000',
        navigationBarContentColor: INK,
        enableNavigationBarAnimation: false
      });
    } catch {
      hilog.warn(0, 'CodexPhone', 'Unable to apply system bar appearance.');
    }
  }
  onWindowStageDestroy(): void {
    this.mainWindow = undefined;
  }
  onForeground(): void {
    this.applyWindowAppearance();
    this.context.eventHub.emit('codex:foreground');
  }
  onBackground(): void {
    this.context.eventHub.emit('codex:background');
  }
}
