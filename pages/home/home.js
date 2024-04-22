import F6 from '@antv/f6-wx';
import TreeGraph from '@antv/f6-wx/extends/graph/treeGraph';

import data_ from './data/index.js';
import demoData from './data/demo.js';

/**
 * 至上而下的紧凑树
 */

Page({
  canvas: null,
  ctx: null, // 延迟获取的2d context
  renderer: '', // mini、mini-native等，F6需要，标记环境
  isCanvasInit: false, // canvas是否准备好了
  graph: null,

  data: {
    width: 375,
    height: 800,
    pixelRatio: 1,
    forceMini: false,
    treeData: {}
  },

  onLoad() {
    // console.log("data_---->", data_);
    let treeData = this.recursiveProcess(demoData.root, demoData.root.data.text);
    console.log("demoData--->", demoData);
    // 注册自定义树，节点等
    F6.registerGraph('TreeGraph', TreeGraph);

    // 同步获取window的宽高
    const { windowWidth, windowHeight, pixelRatio } = wx.getSystemInfoSync();

    this.setData({
      width: windowWidth,
      height: windowHeight,
      pixelRatio,
      treeData
    });
  },

  /**
   * 递归处理结果
   */
  recursiveProcess(json, id){
    let obj = {};
    obj.id = id;
    obj.note = json.data.note || '';
    if(json.children && json.children.length > 0){
      obj.children = json.children.map((item) => {
          return item.children && item.children.length > 0 ? this.recursiveProcess(item, item.data.text) : {id: item.data.text, note: item.data.note, children: []}
      });
    }
    // console.log("obj---->", obj)
    return obj; 
  },
  /**
   * 初始化canvas回调，缓存获得的context
   * @param {*} ctx 绘图context
   * @param {*} rect 宽高信息
   * @param {*} canvas canvas对象，在render为mini时为null
   * @param {*} renderer 使用canvas 1.0还是canvas 2.0，mini | mini-native
   */
  handleInit(event) {
    const { ctx, canvas, renderer } = event.detail;
    this.isCanvasInit = true;
    this.ctx = ctx;
    this.renderer = renderer;
    this.canvas = canvas;
    this.updateChart();
  },

  /**
   * canvas派发的事件，转派给graph实例
   */
  handleTouch(e) {
    this.graph && this.graph.emitEvent(e.detail);
  },

  updateChart() {
    const { width, height, pixelRatio, treeData } = this.data;
    console.log("treeData--->", treeData);

    // 创建F6实例
    this.graph = new F6.TreeGraph({
      context: this.ctx,
      renderer: this.renderer,
      width,
      height,
      pixelRatio,
      fitView: true,
      linkCenter: true,
      modes: {
        default: [
          {
            type: 'collapse-expand',
            onChange: function onChange(item, collapsed) {
              const data = item.getModel();
              data.collapsed = collapsed;
              return true;
            },
          },
          'drag-canvas',
          'zoom-canvas',
        ],
      },
      defaultNode: {
        size: 26,
        anchorPoints: [
          [0, 0.5],
          [1, 0.5],
        ],
      },
      defaultEdge: {
        // type: 'cubic-vertical',
        type: 'cubic-horizontal',
      },
      layout: {
        // type: 'compactBox',
        // direction: 'LR',
        type: 'mindmap',
        direction: 'H',
        getId: function getId(d) {
          return d.id;
        },
        getHeight: function getHeight() {
          return 16;
        },
        getWidth: function getWidth() {
          return 16;
        },
        getVGap: function getVGap() { // 每个节点的垂直间隙
          return 10; // 40;
        },
        getHGap: function getHGap() { // 每个节点的水平间隙
          return 50; 
        },
      },
      radial: true
    });

    this.graph.node((node) => {
      let position = 'right';
      let rotate = 0;
      if (!node.children) {
        position = 'bottom';
        rotate = Math.PI / 2;
      }
      return {
        label: node.id,
        labelCfg: {
          position,
          offset: 5,
          style: {
            rotate,
            textAlign: 'start',
          },
        },
      };
    });
    this.graph.data(treeData);
    this.graph.render();
    this.graph.fitView();
    this.graph.on('node:tap', evt => {
      // 一些操作
      const item = evt.item; // 被操作的节点 item
      const target = evt.target; // 被操作的具体图形
      console.log("evt--->", evt);
    })
  },

  onUnload() {
    this.graph && this.graph.destroy();
  },
});