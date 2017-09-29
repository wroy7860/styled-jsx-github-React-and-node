// Packages
import jsx from 'babel-plugin-syntax-jsx'

import { visitor as externalStylesVisitor } from './babel-external'

import {
  isGlobalEl,
  isStyledJsx,
  findStyles,
  makeStyledJsxTag,
  getJSXStyleInfo,
  computeClassNames,
  addClassName,
  getScope,
  processCss
} from './_utils'

import { STYLE_COMPONENT } from './_constants'

export default function({ types: t }) {
  return {
    inherits: jsx,
    visitor: {
      ImportDefaultSpecifier(path, state) {
        state.imports.push(path.get('local').node.name)
      },
      ImportSpecifier(path, state) {
        state.imports.push(
          (path.get('local') || path.get('imported')).node.name
        )
      },
      VariableDeclarator(path, state) {
        const subpath = path.get('init')
        if (
          !subpath.isCallExpression() ||
          subpath.get('callee').node.name !== 'require'
        ) {
          return
        }
        state.imports.push(path.get('id').node.name)
      },
      JSXOpeningElement(path, state) {
        const el = path.node
        const { name } = el.name || {}

        if (!state.hasJSXStyle) {
          return
        }

        if (state.ignoreClosing === null) {
          // We keep a counter of elements inside so that we
          // can keep track of when we exit the parent to reset state
          // note: if we wished to add an option to turn off
          // selectors to reach parent elements, it would suffice to
          // set this to `1` and do an early return instead
          state.ignoreClosing = 0
        }

        if (
          name &&
          name !== 'style' &&
          name !== STYLE_COMPONENT &&
          name.charAt(0) !== name.charAt(0).toUpperCase()
        ) {
          if (state.jsxId) {
            addClassName(path, state.jsxId)
          }
        }

        state.ignoreClosing++
        // Next visit will be: JSXElement exit()
      },
      JSXElement: {
        enter(path, state) {
          if (state.hasJSXStyle !== null) {
            return
          }

          const styles = findStyles(path)

          if (styles.length === 0) {
            return
          }

          state.styles = []
          state.externalStyles = []

          const scope = getScope(path)

          for (const style of styles) {
            // Compute children excluding whitespace
            const children = style.get('children').filter(
              c =>
                t.isJSXExpressionContainer(c.node) ||
                // Ignore whitespace around the expression container
                (t.isJSXText(c.node) && c.node.value.trim() !== '')
            )

            if (children.length !== 1) {
              throw path.buildCodeFrameError(
                `Expected one child under ` +
                  `JSX Style tag, but got ${children.length} ` +
                  `(eg: <style jsx>{\`hi\`}</style>)`
              )
            }

            const child = children[0]

            if (!t.isJSXExpressionContainer(child)) {
              throw path.buildCodeFrameError(
                `Expected a child of ` +
                  `type JSXExpressionContainer under JSX Style tag ` +
                  `(eg: <style jsx>{\`hi\`}</style>), got ${child.type}`
              )
            }

            const expression = child.get('expression')

            if (t.isIdentifier(expression)) {
              const idName = expression.node.name
              if (state.imports.indexOf(idName) !== -1) {
                const externalStylesIdentifier = t.identifier(idName)
                const isGlobal = isGlobalEl(style.get('openingElement').node)
                state.externalStyles.push([
                  t.memberExpression(
                    externalStylesIdentifier,
                    t.identifier(isGlobal ? '__hash' : '__scopedHash')
                  ),
                  externalStylesIdentifier,
                  isGlobal
                ])
                continue
              }

              throw path.buildCodeFrameError(
                `The Identifier ` +
                  `\`${expression.getSource()}\` is either \`undefined\` or ` +
                  `it is not an external StyleSheet reference i.e. ` +
                  `it doesn't come from an \`import\` or \`require\` statement`
              )
            }

            if (
              !t.isTemplateLiteral(expression) &&
              !t.isStringLiteral(expression)
            ) {
              throw path.buildCodeFrameError(
                `Expected a template ` +
                  `literal or String literal as the child of the ` +
                  `JSX Style tag (eg: <style jsx>{\`some css\`}</style>),` +
                  ` but got ${expression.type}`
              )
            }

            state.styles.push(getJSXStyleInfo(expression, scope))
          }

          let externalJsxId
          if (state.externalStyles.length > 0) {
            const expressions = state.externalStyles
              // Remove globals
              .filter(s => !s[2])
              .map(s => s[0])

            const expressionsLength = expressions.length

            if (expressionsLength === 0) {
              externalJsxId = null
            } else {
              // Construct a template literal of this form:
              // `${styles.__scopedHash} ${otherStyles.__scopedHash}`
              externalJsxId = t.templateLiteral(
                [
                  t.templateElement({ raw: 'jsx-', cooked: '' }),
                  ...[...new Array(expressionsLength - 1)].map(() =>
                    t.templateElement({ raw: ' jsx-', cooked: ' ' })
                  ),
                  t.templateElement({ raw: '', cooked: '' }, true)
                ],
                expressions
              )
            }
          }

          if (state.styles.length > 0 || externalJsxId) {
            const { staticClassName, attribute } = computeClassNames(
              state.styles,
              externalJsxId
            )
            state.jsxId = attribute
            state.staticClassName = staticClassName
          }

          state.hasJSXStyle = true
          state.file.hasJSXStyle = true
          // Next visit will be: JSXOpeningElement
        },
        exit(path, state) {
          const isGlobal = isGlobalEl(path.node.openingElement)

          if (state.hasJSXStyle && !--state.ignoreClosing && !isGlobal) {
            state.hasJSXStyle = null
            state.jsxId = null
            state.externalJsxId = null
          }

          if (!state.hasJSXStyle || !isStyledJsx(path)) {
            return
          }

          if (
            state.externalStyles.length > 0 &&
            path.get('children').filter(child => {
              if (!t.isJSXExpressionContainer(child)) {
                return false
              }
              const expression = child.get('expression')
              return expression && expression.isIdentifier()
            }).length === 1
          ) {
            const [id, css, isGlobal] = state.externalStyles.shift()

            path.replaceWith(
              makeStyledJsxTag(
                id,
                isGlobal
                  ? css
                  : t.memberExpression(
                      t.identifier(css.name),
                      t.identifier('__scoped')
                    )
              )
            )
            return
          }

          const stylesInfo = {
            ...state.styles.shift(),
            fileInfo: {
              file: state.file,
              sourceFileName: state.file.opts.sourceFileName,
              sourceMaps: state.file.opts.sourceMaps
            },
            staticClassName: state.staticClassName,
            isGlobal
          }
          const splitRules =
            typeof state.opts.optimizeForSpeed === 'boolean'
              ? state.opts.optimizeForSpeed
              : process.env.NODE_ENV === 'production'

          const { hash, css, expressions } = processCss(stylesInfo, {
            splitRules
          })

          path.replaceWith(makeStyledJsxTag(hash, css, expressions))
        }
      },
      Program: {
        enter(path, state) {
          state.hasJSXStyle = null
          state.ignoreClosing = null
          state.file.hasJSXStyle = false
          state.imports = []
        },
        exit({ node, scope }, state) {
          if (!(state.file.hasJSXStyle && !scope.hasBinding(STYLE_COMPONENT))) {
            return
          }

          const importDeclaration = t.importDeclaration(
            [t.importDefaultSpecifier(t.identifier(STYLE_COMPONENT))],
            t.stringLiteral('styled-jsx/style')
          )

          node.body.unshift(importDeclaration)
        }
      },

      // Transpile external styles
      ...externalStylesVisitor
    }
  }
}
