/* Builds and then renders a plan graph using Dagre / D3. The JSON for the current query
is retrieved by an HTTP call, and then the graph of nodes and edges is built by walking
over each plan fragment in turn. Plan fragments are connected wherever a node has a
data_stream_target attribute.
<script src="desktop/ext/js/d3.v3.js"></script>
<script src="desktop/ext/js/dagre-d3-min.js"></script>
Copied from https://github.com/apache/incubator-impala/blob/master/www/query_plan.tmpl
*/
function impalaDagre(id) {
  var d3 = window.d3v3;
  var dagreD3 = window.dagreD3;
  var g = new dagreD3.graphlib.Graph().setGraph({rankDir: "BT"});
  var svg = d3.select("#"+id + " svg");
  var inner = svg.select("g");
  var states_by_name = { };
  var colors = HueColors.cuiD3Scale();
  var _impalaDagree = {
    _metrics: {},
    init: function (initialScale) {
      clearSelection();
      zoom.translate([((svg.attr("width") || $("#"+id).width()) - g.graph().width * initialScale) / 2, 20])
      .scale(initialScale)
      .event(svg);
    },
    metrics: function(data) {
      _impalaDagree._metrics = data;
    },
    update: function(plan) {
      _impalaDagree._plan = plan;
      renderGraph();
      _impalaDagree._width = $(svg[0]).width();
    },
    height: function(value) {
      var scale = zoom.scale() || 1;
      var height = value || 600;
      _impalaDagree._height = height;
      svg.attr('height', height);
    },
    action: function(type) {
      if (type == 'plus') {
        zoom.scale(zoom.scale() + 0.25)
        .event(svg);
      } else if (type == 'minus') {
        zoom.scale(zoom.scale() - 0.25)
        .event(svg);
      } else if (type == 'reset') {
        _impalaDagree.init(1);
      }
    },
    moveTo: function(id) {
      zoomToNode(id);
    },
    select: function(id) {
      select(id);
    }
  };
  createActions();

  function createActions () {
    svg.on('click', function () {
      hideDetail();
      clearSelection();
    });
    d3.select("#"+id)
      .style('position', 'relative')
    .append('div')
      .classed('buttons', true)
    .selectAll('button').data([{ type: 'reset', svg: 'hi-crop-free', divider: true }, { type: 'plus', font: 'fa-plus', divider: true }, { type: 'minus', font: 'fa-minus' }])
    .enter()
    .append(function (data) {
      var text = "";
      text += '<div>';
      text += getIcon(data);
      if (data.divider) {
        text += '<div class="divider"></div>';
      }
      text += '</div>';
      var button = $(text)[0];
      $(button).on('click', function () {
        _impalaDagree.action(data.type);
      });
      return button;
    });
    d3.select("#"+id)
    .append('div')
      .classed('details', true);
  }

  // Set up zoom support
  var zoom = d3.behavior.zoom().on("zoom", function() {
    var e = d3.event,
        scale = Math.min(Math.max(e.scale, Math.min(Math.min(_impalaDagree._width / g.graph().width, _impalaDagree._height / g.graph().height), 1)), 2),
        tx = Math.min(40, Math.max(e.translate[0], _impalaDagree._width - 40 - g.graph().width * scale)),
        ty = Math.min(40, Math.max(e.translate[1], _impalaDagree._height - 40 - g.graph().height * scale));
    zoom.translate([tx, ty]);
    zoom.scale(scale);
    inner.attr("transform", "translate(" + [tx, ty] + ")" +
               "scale(" + scale + ")");
  });
  svg.call(zoom);

  // Set of colours to use, with the same colour used for every node in the same plan
  // fragment.
  var colours = ["#A0A0A0", "#E99F01", "#7B46AD", "#A60115", "#00008B", "#006400",
                 "#228B22", "#4B0082", "#DAA520", "#008B8B", "#000000", "#DC143C"];

  // Shades of red in order of intensity, used for colouring nodes by time taken
  var cols_by_time = ["#000000", "#1A0500", "#330A00", "#4C0F00", "#661400", "#801A00",
                      "#991F00", "#B22400", "#CC2900", "#E62E00", "#FF3300", "#FF4719"];

  // Recursively build a list of edges and states that comprise the plan graph
  function build(node, parent, edges, states, colour_idx, max_node_time, index, count) {
    if (node["output_card"] === null || node["output_card"] === undefined) {
      return;
    }
    var id = getId(node["label"]);
    var metric_node = _impalaDagree._metrics && _impalaDagree._metrics.nodes[id]
    var predicates = metric_node && (metric_node.other['group by'] || metric_node.other['hash predicates'] || metric_node.other['predicates']) || '';
    states.push({ "name": node["label"],
                  "type": node["type"],
                  "label": node["name"],
                  "detail": node["label_detail"],
                  "predicates": predicates,
                  "num_instances": node["num_instances"],
                  "num_active": node["num_active"],
                  "max_time": ko.bindingHandlers.numberFormat.human(node["max_time_val"], 5),
                  "avg_time": node["avg_time"],
                  "icon": node["icon"],
                  "parent": parent || node["data_stream_target"],
                  "is_broadcast": node["is_broadcast"],
                  "max_time_val": node["max_time_val"],
                  "width": "200px"});
    if (parent) {
      edges.push({ start: node["label"], end: parent, style: { label: '', labelpos: index === 0 && count > 1 ? 'l' : 'r' }, content: { value: 0, unit: 0 } });
    }
    // Add an inter-fragment edge. We use a red dashed line to show that rows are crossing
    // the fragment boundary.
    if (node["data_stream_target"]) {
      var networkTime = getMaxTotalNetworkTime(node["label"], node["data_stream_target"]);
      var text = ko.bindingHandlers.numberFormat.human(networkTime.value, networkTime.unit);
      edges.push({ "start": node["label"],
                   "end": node["data_stream_target"],
                   "content": networkTime,
                   "style": { label: text,
                              style: "stroke-dasharray: 5, 5;",
                              labelpos: index === 0 && count > 1 ? 'l' : 'r' }});
    }
    max_node_time = Math.max(node["max_time_val"], max_node_time)
    for (var i = 0; i < node["children"].length; ++i) {
      max_node_time = build(
        node["children"][i], node["label"], edges, states, colour_idx, max_node_time, i, node["children"].length);
    }
    return max_node_time;
  }

  var is_first = true;

  function select(node) {
    var key = getKey(node);
    if (!key) {
      return;
    }
    clearSelection();
    $("g.node:contains('" + key + "')").attr('class', 'node active');
    showDetail(node);
  }

  function clearSelection() {
    $("g.node").attr('class', 'node'); // addClass doesn't work in svg on our version of jQuery
  }

  function getId(key) {
    return parseInt(key.split(':')[0], 10);
  }

  function getKey(node) {
    var nodes = g.nodes();
    var key;
    var nNode = parseInt(node, 10);
    var keys = Object.keys(nodes);
    for (var i = 0; i < keys.length; i++) {
      if (getId(nodes[keys[i]]) == nNode) {
        key = nodes[keys[i]];
        break;
      }
    }
    return key;
  }

  function zoomToNode(node) {
    var key = getKey(node);
    if (!key) {
      return;
    }
    var n = $("g.node:contains('" + key + "')")[0];
    var t = d3.transform(d3.select(n).attr("transform")),
        x = t.translate[0],
        y = t.translate[1];

    var scale = 1;

    svg.transition().duration(1000)
        .call(zoom.translate([((x * -scale) + (svg.property("clientWidth") / 2)), ((y * -scale) + svg.property("clientHeight") / 2)])
            .scale(scale).event);
  }

  function getIcon(icon) {
    var html = '';
    if (icon && icon.svg) {
      html += '<svg class="hi"><use xlink:href="#'+ icon.svg +'"></use></svg>'
    } else if (icon && icon.font) {
      html += "<div class='fa fa-fw valign-middle " + icon.font + "'></div>";
    }
    return html;
  }

  function getMaxTotalNetworkTime(sender, receiver) {
    var sentTime = getMaxTotalNetworkSendTime(sender);
    var receiveTime = getMaxTotalNetworkReceiveTime(receiver);
    return receiveTime && sentTime ? { value: Math.min(receiveTime.value, sentTime.value), unit: sentTime.unit } : { value: 0, unit: 0 }; // We get the smallest between both, because sometime 1 of them is larger than the other (doesn't make sense for our purpose)
  }

  function getMaxTotalNetworkSendTime(node) {
    var id = getId(node);
    if (!_impalaDagree._metrics || !_impalaDagree._metrics.nodes[id] || !_impalaDagree._metrics.nodes[_impalaDagree._metrics.nodes[id].fragment]) {
      return;
    }
    var fragment = _impalaDagree._metrics.nodes[_impalaDagree._metrics.nodes[id].fragment];
    return Object.keys(fragment.properties.hosts).reduce(function (previous, host) {
      if (fragment.properties.hosts[host].TotalNetworkSendTime.value > previous.value) {
        return fragment.properties.hosts[host].TotalNetworkSendTime;
      } else {
        return previous;
      }
    }, { value: -1, unit: 5 });
  }

  function getMaxTotalNetworkReceiveTime(node) {
    var id = getId(node);
    if (!_impalaDagree._metrics || !_impalaDagree._metrics.nodes[id] || !_impalaDagree._metrics.nodes[_impalaDagree._metrics.nodes[id].fragment]) {
      return;
    }
    var fragment = _impalaDagree._metrics.nodes[_impalaDagree._metrics.nodes[id].fragment];
    return Object.keys(fragment.properties.hosts).reduce(function (previous, host) {
      if (fragment.properties.hosts[host].TotalNetworkReceiveTime.value > previous.value) {
        return fragment.properties.hosts[host].TotalNetworkReceiveTime;
      } else {
        return previous;
      }
    }, { value: -1, unit: 5 });
  }

  // This is not exact, but shows some approximation of reality.
  function getCPUTimelineData(key) {
    var datum = getTimelineData(key);
    if (!datum || !datum.hosts[datum.min] || !datum.hosts[datum.min]['Node Lifecycle Event Timeline']) {
      return '';
    }
    var id = getId(key);
    var localTime = _impalaDagree._metrics.nodes[id].properties.hosts[datum.min].LocalTime;
    var timeline = datum.hosts[datum.min]['Node Lifecycle Event Timeline'];
    if (!timeline.length) {
      return '';
    }
    var openFinished = timeline.filter(function(time) {
      return time.name === 'Open Finished';
    })[0];
    var last = timeline.filter(function(time) {
      return time.name !== 'Closed';
    }); // Close time is normally wait time;
    last = last[last.length - 1];
    var time;
    if (!openFinished) {
      var end = _impalaDagree._metrics && _impalaDagree._metrics['max'] || 10;
      time = { start_time: end - localTime.value, duration: localTime.value, value: end, color: last.color, unit: last.unit };
    } else if (key.indexOf('JOIN') >= 0) {
      time = { start_time: openFinished.value - localTime.value, duration: localTime.value, value: openFinished.value, color: last.color, unit: last.unit };
    } else if (key.indexOf('UNION') >= 0 || (key.indexOf('AGGREGATE') >= 0 && states_by_name[key].detail.indexOf('STREAMING') >= 0)) {
      time = { start_time: openFinished.value, duration: localTime.value, value: localTime.value + openFinished.value, color: last.color, unit: last.unit };
    } else {
      time = { start_time: last.value - localTime.value, duration: localTime.value, value: last.value, color: last.color, unit: last.unit };
    }
    return [ time ];
  }

  function getTimelineData(key) {
    if (!_impalaDagree._metrics) {
      return;
    }
    var id = getId(key);
    if (!_impalaDagree._metrics.nodes[id] || !_impalaDagree._metrics.nodes[id].timeline) {
      return;
    }
    var timeline = _impalaDagree._metrics.nodes[id].timeline;
    var times = Object.keys(timeline.hosts);
    for (var i = 0; i < times.length; i++) {
      if (!timeline.hosts[times[i]]['Node Lifecycle Event Timeline']) {
        continue;
      }
      timeline.hosts[times[i]]['Node Lifecycle Event Timeline'].forEach(function (time, index, array) {
        time.color = colors[index % colors.length];
        return time;
      });
    }
    return timeline;
  }

  function renderTimeline(key) {
    var datum = getTimelineData(key);
    if (!datum || !datum.hosts[datum.min] || !datum.hosts[datum.min]['Node Lifecycle Event Timeline']) {
      return '';
    }
    var end = _impalaDagree._metrics && _impalaDagree._metrics['max'] || 10;
    var divider = end > 33554428 ? 1000000 : 1; // values are in NS, scaling to MS as max pixel value is 33554428px ~9h in MS
    var html = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + (end / divider) + ' 10" class="timeline" preserveAspectRatio="none">';
    html += datum.hosts[datum.min]['Node Lifecycle Event Timeline'].map(function(time, index) {
      return '<rect x="' + (time.start_time / divider) + '" width="' + (time.duration / divider)  + '" height="10" style="fill:' + time.color  +'"></rect>';
    }).join('');
    html += '</svg>';
    return html;
  }

  function renderCPUTimeline(key) {
    var datum = getCPUTimelineData(key);
    if (!datum) {
      return '';
    }
    var end = _impalaDagree._metrics && _impalaDagree._metrics['max'] || 10;
    var divider = end > 33554428 ? 1000000 : 1; // values are in NS, scaling to MS as max pixel value is 33554428px ~9h in MS
    var html = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + (end / divider) + ' 10" class="timeline" preserveAspectRatio="none">';
    html += datum.map(function(time, index) {
      return '<rect class="active" x="' + (time.start_time / divider) + '" width="' + (time.duration / divider)  + '" height="10"></rect>';
    }).join('');
    html += '</svg>';
    return html;
  }

  function showDetail(id) {
    var data;
    if (!_impalaDagree._metrics || !_impalaDagree._metrics.nodes[id]) {
      return;
    }
    var data = _impalaDagree._metrics.nodes[id];

    d3.select('.query-plan').classed('open', true);
    var details = d3.select('.query-plan .details');
    var key = getKey(id);
    details.html('<header class="metric-title">' + getIcon(states_by_name[key].icon) + '<h4>' + states_by_name[key].label+ '</h4></div>')
    var detailsContent = details.append('div').classed('details-content', true);

    var timeline = renderTimeline(key, '');
    if (timeline) {
      var timelineSection = detailsContent.append('div').classed('details-section', true);
      var timelineTitle = timelineSection.append('header');
      timelineTitle.append('svg').classed('hi', true).append('use').attr('xlink:href', '#hi-access-time');
      timelineTitle.append('h5').text(window.HUE_I18n.profile.timeline);
      timelineSection.node().appendChild($.parseXML(renderTimeline(key, '')).children[0]);

      var timelineSectionTable = timelineSection.append('table');
      timelineSectionTable.append('thead').selectAll('tr').data(['\u00A0'].concat(Object.keys(_impalaDagree._metrics.nodes[id].timeline.hosts).sort())).enter().append('tr').append('td').text(function (host, i) { return i > 0 ? 'Host ' + i : host; }).attr('title', function (host) { return host; });
      var timelineSectionTableBody = timelineSectionTable.append('tbody');
      var timelineHosts = Object.keys(_impalaDagree._metrics.nodes[id].timeline.hosts).sort().map(function (host) { return _impalaDagree._metrics.nodes[id].timeline.hosts[host]; });
      var timelineSectionTableCols = timelineSectionTableBody.selectAll('tr').data(timelineHosts);
      var timelineSectionTableCol0 = timelineSectionTableBody.selectAll('tr').data(timelineHosts.slice(0,1));
      timelineSectionTableCol0.enter().append('tr').selectAll('td').data(function (x) { return x['Node Lifecycle Event Timeline']; }).enter().append('td').html(function (time) { return '<div class="legend-icon" title="' + time.name + '" style="background-color:' + time.color +' "></div><div class="metric-name">' + time.name + '</div>'; });
      timelineSectionTableCols.enter().append('tr').selectAll('td').data(function (x) { return x['Node Lifecycle Event Timeline']; }).enter().append('td').text(function (datum) { return ko.bindingHandlers.numberFormat.human(datum.duration, datum.unit); });
    }

    var metricsSection = detailsContent.append('div').classed('details-section', true);
    var metricsChildSections = metricsSection.selectAll('div').data(Object.keys(data.children));

    var metricsTitle = metricsSection.append('header');
    metricsTitle.append('svg').classed('hi', true).append('use').attr('xlink:href', '#hi-bar-chart');
    metricsTitle.append('h5').text(window.HUE_I18n.profile.metrics);

    var metricsContent = metricsSection.append('table').classed('metrics', true);
    var metricsHosts = Object.keys(data.properties.hosts).sort().map(function (key) { return data.properties.hosts[key]; });
    var metricsCols = metricsContent.selectAll('tr').data(metricsHosts);
    var metricsCols0 = metricsContent.selectAll('tr').data(metricsHosts.slice(0,1));
    metricsCols0.enter().append('tr').selectAll('td').data(function (host) { return Object.keys(host).sort(); }).enter().append('td').text(function (x) { return x; }).attr('title', function (x) { return x; });
    metricsCols.enter().append('tr').selectAll('td').data(function (x) { return Object.keys(x).sort().map(function (key) {return x[key]; }) }).enter().append('td').text(function (datum) { return ko.bindingHandlers.numberFormat.human(datum.value, datum.unit); });
    metricsContent.append('thead').selectAll('tr').data(['\u00A0'].concat(Object.keys(data.properties.hosts).sort())).enter().append('tr').append('td').text(function (x, i) { return i > 0 ? x === 'averaged' ? x : 'Host ' + (i - 1) : x; }).attr('title', function (x) {return x;});

    var metricsChildSectionsContent = metricsChildSections.enter().append('div');
    metricsChildSectionsContent.append('header').append('h5').text(function (key) { return key; });
    var metricsChildSectionsContentTable = metricsChildSectionsContent.append('table').classed('metrics', true);
    var fChildrenHosts = function (key) { return Object.keys(data.children[key].hosts).sort().map(function (host) { return data.children[key].hosts[host]; }); };
    var metricsChildSectionsContentCols = metricsChildSectionsContentTable.selectAll('tr').data(function (key) { return fChildrenHosts(key); });
    var metricsChildSectionsContentCols0 = metricsChildSectionsContentTable.selectAll('tr').data(function (key) { return fChildrenHosts(key).slice(0,1); });
    metricsChildSectionsContentCols0.enter().append('tr').selectAll('td').data(function (host) { return Object.keys(host).sort(); }).enter().append('td').text(function (x) { return x; }).attr('title', function (x) { return x; });
    metricsChildSectionsContentCols.enter().append('tr').selectAll('td').data(function (x) { return Object.keys(x).sort().map(function (key) {return x[key]; }) }).enter().append('td').text(function(datum) { return ko.bindingHandlers.numberFormat.human(datum.value, datum.unit);});
    metricsChildSectionsContentTable.append('thead').selectAll('tr').data(function (key) { return ['\u00A0'].concat(Object.keys(data.children[key].hosts).sort()); }).enter().append('tr').append('td').text(function (x, i) { return i > 0 ? x === 'averaged' ? x : 'Host ' + (i - 1) : x; }).attr('title', function (x) {return x;});
  }

  function hideDetail(id) {
    d3.select('.query-plan').classed('open', false);
  }

  function getProperty(object, path) {
    var keys = path.split('.');
    for (var i = 0; i < keys.length; i++) {
      object = object[keys[i]];
    }
    return object;
  }

  function average(states, metric) {
    var sum = 0;
    for (var i = 0; i < states.length; i++) {
      sum += getProperty(states[i], metric);
    }
    return states.length > 0 ? sum / states.length : 0;
  }

  function averageCombined(avg1, avg2, count1, count2) {
    return (avg1 * count1 + avg2 * count2) / (count1 + count2);
  }

  function renderGraph() {
    var plan = _impalaDagree._plan;
    if (!plan || !plan.plan_nodes || !plan.plan_nodes.length) return;
    var states = [];
    var edges = [];
    var colour_idx = 0;

    var max_node_time = 0;
    plan["plan_nodes"].forEach(function(parent) {
      max_node_time = Math.max(
        build(parent, null, edges, states, colour_idx, max_node_time, 1, 1));
      // Pick a new colour for each plan fragment
      colour_idx = (colour_idx + 1) % colours.length;
    });
    var avgStates = average(states, 'max_time_val');
    var edgesIO = edges.filter(function (edge) {
      return edge.content.unit === 5;
    });
    var edgesNonIO = edges.filter(function (edge) {
      return edge.content.unit === 0;
    });
    var avgEdgesIO = average(edgesIO, 'content.value');
    var avgEdgesNonIO = average(edgesNonIO, 'content.value');
    var avgCombined = averageCombined(avgStates, avgEdgesIO, states.length, edgesIO.length);
    var avg = { '0': avgEdgesNonIO, '5': avgCombined};
    // Keep a map of names to states for use when processing edges.
    states.forEach(function(state) {
      // Build the label for the node from the name and the detail
      var html = "<div onclick=\"event.stopPropagation(); huePubSub.publish('impala.node.select', " + getId(state.name) + ");\">"; // TODO: Remove Hue dependency
      html += getIcon(state.icon);
      html += "<span style='display: inline-block;'><span class='name'>" + state.label + "</span><br/>";
      var aboveAverageClass = state.max_time_val > avgCombined ? 'above-average' : '';
      html += "<span class='metric " + aboveAverageClass + "'>" + state.max_time + "</span>";
      html += "<span class='detail'>" + state.detail + "</span><br/>";
      if (state.predicates) {
        html += "<span class='detail'>" + state.predicates + "</span><br/>";
      }
      html += "<span class='id'>" + state.name + "</span></span>";
      html += renderCPUTimeline(state.name);
      html += "</div>";

      var style = state.style;

      g.setNode(state.name, { "label": html,
                              "labelType": "html",
                              "style": style });
      states_by_name[state.name] = state;
    });
    edges.forEach(function(edge) {
      // Impala marks 'broadcast' as a property of the receiver, not the sender. We use
      // '(BCAST)' to denote that a node is duplicating its output to all receivers.
      /*if (states_by_name[edge.end].is_broadcast) {
        if (states_by_name[edge.end].num_instances > 1) {
          edge.style.label += " * " + states_by_name[edge.end].num_instances;
        }
      }*/
      if (edge.content.value > avg[edge.content.unit]) {
        edge.style.labelStyle = "font-weight: bold";
      }
      g.setEdge(edge.start, edge.end, edge.style);
    });

    g.nodes().forEach(function(v) {
      var node = g.node(v);
      node.rx = node.ry = 5;
    });

    // Create the renderer
    var render = new dagreD3.render();

    // Run the renderer. This is what draws the final graph.
    render(inner, g);

    // Center the graph, but only the first time through (so as to not lose user zooms).
    if (is_first) {
      var initialScale = 1;
      _impalaDagree.init(initialScale);
      svg.attr('height', Math.min(g.graph().height * initialScale + 40, 600));
      is_first = false;
    }

  }

  return _impalaDagree;
}