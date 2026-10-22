import { Icon } from "../Icon";

/* What the composer turns into while a file is dragged over the window, after
 * Bencho's upload dropzone (bencho.dev/blocks/upload-dropzone, MIT).
 *
 * It used to be a recoloured border. Now the box itself becomes the target:
 * an upload tile that lifts as the file arrives, a line saying what letting
 * go does, and a dashed ring that marches round the edge so the drop target
 * reads as live rather than merely tinted. Letting go plays Bencho's "gulp" --
 * the box gives a little under the file and springs back -- which the composer
 * runs off `data-gulp`. */
export function DropZone({ active }) {
  return (
    <div className="dropzone" data-on={active ? "" : undefined} aria-hidden={!active}>
      <svg className="dropzone-ring" aria-hidden="true">
        <rect />
      </svg>
      <span className="dropzone-icon">
        <Icon name="upload" />
      </span>
      <span className="dropzone-say">
        <b>Drop to attach</b>
        <span>It rides along with your next message</span>
      </span>
    </div>
  );
}
