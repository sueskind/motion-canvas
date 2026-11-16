import {RendererState} from '@motion-canvas/core';
import {useApplication} from '../../contexts';
import {useRendererState, useStorage} from '../../hooks';
import {openOutputPath} from '../../utils';
import {
  Button,
  ButtonSelect,
  Group,
  Label,
  Select,
  Separator,
} from '../controls';
import {Expandable} from '../fields';
import {MetaFieldView} from '../meta';
import {Pane} from '../tabs';

const SCENE_DESCRIPTION =
  'Render only the selected scene.\nThe range is ignored while a scene is selected.';

export function VideoSettings() {
  const {meta, project} = useApplication();
  const [processId, setProcess] = useStorage('main-action', 0);
  const [storedScene, setScene] = useStorage<string | null>(
    'render-scene',
    null,
  );
  const sceneNames = project.scenes.map(scene => scene.name);
  // The stored scene may have been renamed or removed since.
  const scene = sceneNames.includes(storedScene) ? storedScene : null;

  return (
    <Pane title="Video Settings" id="settings-pane">
      <Expandable title={meta.shared.name} open>
        <MetaFieldView field={meta.shared} />
      </Expandable>
      <Expandable title={meta.preview.name} open>
        <MetaFieldView field={meta.preview} />
      </Expandable>
      <Expandable title={meta.rendering.name} open>
        <MetaFieldView field={meta.rendering} />
        <Group title={SCENE_DESCRIPTION}>
          <Label title={SCENE_DESCRIPTION}>scene</Label>
          <Select
            options={[
              {value: null, text: 'All scenes'},
              ...sceneNames.map(name => ({value: name, text: name})),
            ]}
            value={scene}
            onChange={setScene}
          />
        </Group>
        <Separator />
        <Group>
          <Label />
          <ProcessButton
            processId={processId}
            setProcess={setProcess}
            scene={scene}
          />
        </Group>
        {processId === 0 && (
          <Group>
            <Label />
            <Button
              title="Reveal the output directory in file explorer"
              onClick={openOutputPath}
            >
              Output Directory
            </Button>
          </Group>
        )}
      </Expandable>
    </Pane>
  );
}

interface ProcessButtonProps {
  processId: number;
  setProcess: (id: number) => void;
  scene: string | null;
}

function ProcessButton({processId, setProcess, scene}: ProcessButtonProps) {
  const {renderer, presenter, meta, project} = useApplication();
  const rendererState = useRendererState();

  return rendererState === RendererState.Initial ? (
    <ButtonSelect
      main
      id="render"
      value={processId}
      onChange={setProcess}
      onClick={() => {
        if (processId === 0) {
          renderer.render({
            ...meta.getFullRenderingSettings(),
            name: project.name,
            scene,
          });
        } else {
          presenter.present({
            ...meta.getFullRenderingSettings(),
            name: project.name,
            slide: null,
          });
        }
      }}
      options={[
        {
          value: 0,
          text: 'Render',
        },
        {value: 1, text: 'Present'},
      ]}
    />
  ) : (
    <Button
      main
      loading
      id="render"
      data-rendering={true}
      disabled={rendererState === RendererState.Aborting}
      onClick={() => {
        renderer.abort();
      }}
    >
      {rendererState === RendererState.Working ? 'Abort' : 'Aborting'}
    </Button>
  );
}
