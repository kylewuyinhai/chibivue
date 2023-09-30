import { isArray, isString } from "../shared";
import {
  NodeTypes,
  RootNode,
  TemplateChildNode,
  ParentNode,
  Property,
  ElementNode,
  DirectiveNode,
  createVNodeCall,
} from "./ast";
import { TransformOptions } from "./options";
import { CREATE_COMMENT, FRAGMENT, helperNameMap } from "./runtimeHelpers";

export type NodeTransform = (
  node: RootNode | TemplateChildNode,
  context: TransformContext
) => void | (() => void) | (() => void)[];

export type DirectiveTransform = (
  dir: DirectiveNode,
  node: ElementNode,
  context: TransformContext,
  augmentor?: (ret: DirectiveTransformResult) => DirectiveTransformResult
) => DirectiveTransformResult;

export interface DirectiveTransformResult {
  props: Property[];
}

export type StructuralDirectiveTransform = (
  node: ElementNode,
  dir: DirectiveNode,
  context: TransformContext
) => void | (() => void);

export interface TransformContext extends Required<TransformOptions> {
  currentNode: RootNode | TemplateChildNode | null;
  parent: ParentNode | null;
  childIndex: number;
  helpers: Map<symbol, number>;
  helper<T extends symbol>(name: T): T;
  helperString(name: symbol): string;
  replaceNode(node: TemplateChildNode): void;
  removeNode(node?: TemplateChildNode): void;
  onNodeRemoved(): void;
}

export function createTransformContext(
  root: RootNode,
  { nodeTransforms = [], directiveTransforms = {} }: TransformOptions
): TransformContext {
  const context: TransformContext = {
    nodeTransforms,
    directiveTransforms,
    currentNode: root,
    parent: null,
    childIndex: 0,
    helpers: new Map(),
    helper(name) {
      const count = context.helpers.get(name) || 0;
      context.helpers.set(name, count + 1);
      return name;
    },
    helperString(name) {
      return `_${helperNameMap[context.helper(name)]}`;
    },
    replaceNode(node) {
      context.parent!.children[context.childIndex] = context.currentNode = node;
    },
    removeNode(node) {
      const list = context.parent!.children;
      const removalIndex = node
        ? list.indexOf(node)
        : context.currentNode
        ? context.childIndex
        : -1;
      if (!node || node === context.currentNode) {
        // current node removed
        context.currentNode = null;
        context.onNodeRemoved();
      } else {
        // sibling node removed
        if (context.childIndex > removalIndex) {
          context.childIndex--;
          context.onNodeRemoved();
        }
      }
      context.parent!.children.splice(removalIndex, 1);
    },
    onNodeRemoved: () => {},
  };

  return context;
}

export function transform(root: RootNode, options: TransformOptions) {
  const context = createTransformContext(root, options);
  traverseNode(root, context);
  createRootCodegen(root, context);
  root.helpers = new Set([...context.helpers.keys()]);
}

function createRootCodegen(root: RootNode, context: TransformContext) {
  const { helper } = context;
  root.codegenNode = createVNodeCall(
    context,
    helper(FRAGMENT),
    undefined,
    root.children
  );
}

export function traverseNode(
  node: RootNode | TemplateChildNode,
  context: TransformContext
) {
  context.currentNode = node;

  const { nodeTransforms } = context;
  const exitFns = [];
  for (let i = 0; i < nodeTransforms.length; i++) {
    const onExit = nodeTransforms[i](node, context);
    if (onExit) {
      if (isArray(onExit)) {
        exitFns.push(...onExit);
      } else {
        exitFns.push(onExit);
      }
    }
    if (!context.currentNode) {
      return;
    } else {
      node = context.currentNode;
    }
  }

  switch (node.type) {
    case NodeTypes.COMMENT:
      context.helper(CREATE_COMMENT);
      break;
    case NodeTypes.INTERPOLATION:
      break;
    case NodeTypes.IF:
      for (let i = 0; i < node.branches.length; i++) {
        traverseNode(node.branches[i], context);
      }
      break;
    case NodeTypes.IF_BRANCH:
    case NodeTypes.ELEMENT:
    case NodeTypes.ROOT:
      traverseChildren(node, context);
      break;
  }

  context.currentNode = node;
  let i = exitFns.length;
  while (i--) {
    exitFns[i]();
  }
}

export function traverseChildren(
  parent: ParentNode,
  context: TransformContext
) {
  let i = 0;
  const nodeRemoved = () => {
    i--;
  };
  for (; i < parent.children.length; i++) {
    const child = parent.children[i];
    if (isString(child)) continue;
    context.parent = parent;
    context.childIndex = i;
    context.onNodeRemoved = nodeRemoved;
    traverseNode(child, context);
  }
}

export function createStructuralDirectiveTransform(
  name: string | RegExp,
  fn: StructuralDirectiveTransform
): NodeTransform {
  const matches = isString(name)
    ? (n: string) => n === name
    : (n: string) => name.test(n);

  return (node, context) => {
    if (node.type === NodeTypes.ELEMENT) {
      const { props } = node;
      const exitFns = [];
      for (let i = 0; i < props.length; i++) {
        const prop = props[i];
        if (prop.type === NodeTypes.DIRECTIVE && matches(prop.name)) {
          props.splice(i, 1);
          i--;
          const onExit = fn(node, prop, context);
          if (onExit) exitFns.push(onExit);
        }
      }
      return exitFns;
    }
  };
}